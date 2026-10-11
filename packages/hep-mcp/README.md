# @nullius/hep-mcp

Current most mature HEP domain pack. Local stdio MCP server exposing `hep_*` tools for paper/evidence projects, evidence retrieval, literature search exports, and provider-local composition.

## Layer

Domain workflow pack. The strongest end-to-end example in the repo, but **not the root product identity** — generic lifecycle and contracts live in `@nullius/orchestrator` and `@nullius/shared`. See root [README.md](../../README.md) §3 Layer Model.

Paper/evidence projects, `hep://projects/...` identifiers and local catalogs belong to this domain pack; they are not generic lifecycle or approval authority. `hep-mcp` keeps no runs of its own: runs, approvals and lifecycle belong to the orchestrator (`<project_root>/artifacts/runs/<run_id>/`). Tools that produce files (`hep_inspire_search_export`, `hep_inspire_resolve_identifiers`, `hep_import_from_zotero`, `inspire_parse_latex`, `inspire_theoretical_conflicts`, and `inspire_search` when given `output_dir`) write them into a caller-chosen `output_dir`, typically a subdirectory of the current run directory, and return project-relative paths (`export_path`, `meta_path`, `mapping_path`, `path`, `artifacts[].path`). INSPIRE lookups made through the response cache (by `hep_inspire_search_export`, `hep_inspire_resolve_identifiers`, `inspire_search` with `output_dir`, and the INSPIRE resolution step of `hep_import_from_zotero`) are recorded request by request under `<output_dir>/external_api/`; other provider calls (the Zotero local API, the paper fetches of `inspire_theoretical_conflicts`, the source retrieval of `inspire_parse_latex`) are not recorded there. `hep_project_query_evidence` is lexical only. There are no draft rendering, project export or paper bundling tools.

Historical HEP run directories (`runs/<run_id>/` under a HEP data root) written by earlier versions are evidence: they stay readable in place and no tool creates or rewrites them. [docs/URI_REGISTRY.md](../../docs/URI_REGISTRY.md) gives the reading rule for historical `hep://runs/...` references.

## Aggregated providers

`hep-mcp` re-exposes a curated subset of the bounded provider MCP atoms (`arxiv-mcp`, `openalex-mcp`, `hepdata-mcp`, `pdg-mcp`, `zotero-mcp`) under `hep_*` namespaces. Zotero aggregation is gated by `HEP_ENABLE_ZOTERO` (set to `0` to hide `hep_import_from_zotero` and friends); the other providers are always included when present.

The live tool inventory is code-owned and mode-filtered by `HEP_TOOL_MODE` (`standard`, `full`). Exact counts live in the generated category and status docs, not in this README — see the drift lock below.

Compact paper summaries keep up to three author names and carry `authors_omitted`
when names are omitted, including omissions from earlier projections. Markdown
paper views show up to ten names with an explicit `et al. (+N more)` marker when
the list is incomplete. Use the source record for the complete author list.

The [personal plugin](../skills-market/docs/PERSONAL_PLUGIN.md) composes this server
with [`project-mcp`](../project-mcp/README.md) and `idea-mcp`, plus the existing
research skills. It does not register the atomic providers again. Portable manifests launch it through `nullius runtime mcp hep-mcp` using host-private
configuration. HEP can run standalone; when `NULLIUS_PROJECT_ROOT` is configured
it becomes the cwd so the existing project harness applies;
HEP tool calls still use their own `project_root` argument for durable artifact
routing. HEP retains its local-server capabilities and trust boundary; the
project adapter's file restrictions do not sandbox HEP or expose HEP caches
outside the bound project. Chat/Work/Claude-host connections are separate from
the locally tested composition and remain unverified.

## Data root

Resolved per tool call, in this order:

1. `project_root` argument (for an initialized nullius project) → `<project_root>/artifacts/hep-mcp/`
2. `HEP_DATA_DIR` env when set
3. `~/.nullius/hep-mcp/` (scratch fallback)

`PDG_DATA_DIR` follows the resolved root by default at `<resolved root>/pdg`.

A `project_root` is admitted as at the other nullius front doors: in canonical
(symlink-resolved) form, outside any nullius checkout, and initialized. The
admin tools (`hep_admin_migrate_papers_cache`, `hep_admin_prune_paper_cache`,
`hep_admin_link_kb_notes`) admit their project roots the same way. The
project-local directories a call actually uses must be reached through real
directories: for ordinary tool calls these are `artifacts/`,
`artifacts/hep-mcp/` and `artifacts/hep-mcp/pdg/`, and a symlink there
(dangling or not) is refused rather than followed out of the project. An admin
tool uses `artifacts/hep-mcp/` unless its `hep_data_root` override selects
another directory; an override inside the project is held to the same rule,
and an override outside the project is an independent data root chosen by the
caller, as `HEP_DATA_DIR` is. Absolute
paths compared with the data root, such as `output_dir`, may name the project
through any alias of its root, while a path that really lands outside it,
including through a dangling symlink, is refused.

`output_dir` requires `project_root`. It is relative to the project root or
absolute (any spelling of the root), is created if missing, may not traverse a
symbolic link below the project root, may not lie under `.nullius/`,
`team/runs/` or `artifacts/hep-mcp/`, and may not be the project root itself.

## Build & run

```bash
pnpm -r build
node packages/hep-mcp/dist/index.js
```

Wire into an MCP client (Cursor / Claude Desktop / Claude Code / Codex / OpenCode / etc.):

```json
{
  "mcpServers": {
    "hep-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/nullius/packages/hep-mcp/dist/index.js"],
      "env": {
        "HEP_DATA_DIR": "~/.nullius/hep-mcp",
        "HEP_TOOL_MODE": "standard"
      }
    }
  }
}
```

`inspire_literature` accepts the common optional `project_root` in all seven modes while retaining each mode's own required and allowed provider arguments. Its advertised catalog, parser and dispatcher agree; `size` is optional and is not required by modes that reject it.

## Front-door drift lock

The tool inventory, doc tables, and category counts are tied together by:

```bash
pnpm --filter @nullius/hep-mcp docs:tool-counts:check
pnpm --filter @nullius/hep-mcp test -- tests/docs/docToolDrift.test.ts
```

These fail closed when `docs/TOOL_CATEGORIES.md` or `meta/docs/orchestrator-mcp-tools-spec.md` drift from the live registry.

## Build & test

```bash
pnpm -C packages/hep-mcp build
pnpm -C packages/hep-mcp test
```

## See also

- Root [README.md](../../README.md) — surface policy and end-to-end smoke path
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §5.1 — `HEP_DATA_DIR` resolution
- [docs/TOOL_CATEGORIES.md](../../docs/TOOL_CATEGORIES.md) — live tool taxonomy
