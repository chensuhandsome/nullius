# @nullius/hep-mcp

Current most mature HEP domain pack and end-to-end workflow example. Local stdio MCP server exposing `hep_*` tools for projects, runs, evidence, writing, export, and provider-local composition.

## Layer

Domain workflow pack. The strongest end-to-end example in the repo, but **not the root product identity** — generic lifecycle and contracts live in `@nullius/orchestrator` and `@nullius/shared`. See root [README.md](../../README.md) §3 Layer Model.

Projects, run manifests, artifact URIs and local catalogs belong to this domain pack. They are artifact sessions, not generic lifecycle or approval authority. `hep_render_latex` renders structured drafts without verifying source support or enforcing citation allowlists: omitted `is_grounded` remains unknown, and explicit flags are caller assertions. `hep_export_project` rejects missing BibTeX entries for cited keys; this does not verify the claims themselves.

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
