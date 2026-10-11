#!/usr/bin/env node

/**
 * ART-03: atomic-write anti-drift CI check.
 *
 * Locks in the P1 migration (PRs #17, #18, #19, #20) by failing CI if any
 * new production-code site introduces a bare `fs.writeFileSync`,
 * `fs.renameSync`, `fs.appendFileSync`, `fs.promises.writeFile`,
 * `fs.promises.rename`, or `fs.promises.appendFile`. Every artifact write
 * in production paths must go through the six durable primitives in
 * `@nullius/shared` (`writeBytesAtomicDurable`, `writeJsonAtomicDurable`,
 * `appendJsonlDurable`, `appendBytesDurable`, `writeExecutableAtomicDurable`,
 * `commitStagedDurable`).
 *
 * Why this matters:
 *   - Bare writeFileSync/renameSync skips the file fsync + parent-dir fsync
 *     that the durable primitives perform, leaving artifact files vulnerable
 *     to power-loss truncation between write and the next OS flush, or to
 *     directory-entry loss between rename and the next OS flush.
 *   - We've migrated every production site in orchestrator/src and
 *     hep-mcp/src to the durable primitives. New code must follow.
 *
 * Allowed exceptions (any new exception MUST be justified inline below):
 *
 *   1. packages/shared/src/atomic-write.ts — the primitive implementation
 *      itself. It is the SOURCE of the durable sequence; it has to call the
 *      bare fs operations internally.
 *
 *   2. packages/hep-mcp/src/data/papersCacheFetch.ts:179 —
 *      cross-parent dir-rename (arxivSubdir → finalLatexDir, different
 *      parents under the same tmpContentDir). `commitStagedDurable`
 *      requires same-parent, so this site cannot be migrated directly. The
 *      enclosing tmpContentDir is durably committed at a higher level via
 *      papersCache.ts (`commitStagedDurable(tmpRoot, paths.root)`), which
 *      subsumes this intermediate rename's local durability.
 *
 * Import-bound rule: the patterns below only see calls spelled `fs.<name>`.
 * A file that imports a writer under another binding — a named import
 * (`import { writeFileSync } from 'node:fs'`), an alias, a default import, or
 * a namespace bound to `fs/promises` (`import * as fs from 'fs/promises'`,
 * then `fs.writeFile`, or `import { promises as fsp } from 'fs'`, then
 * `fsp.writeFile`) — is also scanned for calls through that binding. The
 * writers are writeFileSync / renameSync / appendFileSync /
 * createWriteStream / writeFile / rename / appendFile (fs), and writeFile /
 * rename / appendFile (fs/promises). `createWriteStream` is included because
 * it opens the final path with 'w' by default: it follows a link left at that
 * name and leaves a partial file behind on failure. Streamed content goes
 * through `writeChunksAtomicDurable`.
 *
 * Exceptions to the import-bound rule are listed per exact source line in
 * BOUND_CALL_EXCEPTIONS below, each with its reason; one entry excuses one
 * occurrence. An edited line is flagged again, and an exception whose line no
 * longer exists fails the check, so the list cannot outlive the code it
 * excuses. The per-file ALLOWLIST keeps its meaning and applies to both rules.
 *
 * Not detected (known limits): a writer reached through a binding made by
 * assignment (`const fsp = fs.promises`) or through a property
 * (`this.fs.writeFile`), or bound by `require('fs')` or a dynamic
 * `import('fs')`; writable descriptors from open/openSync ('w', 'a', 'a+',
 * 'r+') and ftruncateSync — these include in-place appends and repairs of logs
 * and ledgers at their own names, which follow a link left at that name too;
 * copyFileSync/cpSync; and writes made by child processes (for example a
 * renderer given an output path).
 *
 * Scanned packages (production code only — tests excluded): every
 * packages/<name>/src, so a package added later is covered from its first
 * commit (packages/shared/src/atomic-write.ts allowlisted).
 *
 * Excluded from scanning:
 *   - **\/__tests__\/**
 *   - **\/tests\/**
 *   - **\/*.test.ts, **\/*.spec.ts
 *   - **\/dist\/**, **\/node_modules\/**
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCANNED_ROOTS = readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => `packages/${entry.name}/src`)
  .sort();

const FORBIDDEN_PATTERNS = [
  // sync namespaced
  /\bfs\.writeFileSync\b/,
  /\bfs\.renameSync\b/,
  /\bfs\.appendFileSync\b/,
  // promises namespaced
  /\bfs\.promises\.writeFile\b/,
  /\bfs\.promises\.rename\b/,
  /\bfs\.promises\.appendFile\b/,
  // destructured promises (less common but valid TS)
  /\bpromises\.writeFile\b/,
  /\bpromises\.rename\b/,
  /\bpromises\.appendFile\b/,
];

// Repo-relative paths that are allowed to keep bare fs writes/renames. Every
// entry MUST be justified in the file-level docstring above.
const ALLOWLIST = new Set([
  'packages/shared/src/atomic-write.ts',
  'packages/hep-mcp/src/data/papersCacheFetch.ts',
]);

const FS_MODULES = new Set(['fs', 'node:fs']);
const FS_PROMISES_MODULES = new Set(['fs/promises', 'node:fs/promises']);
const FS_WRITERS = ['writeFileSync', 'renameSync', 'appendFileSync', 'createWriteStream', 'writeFile', 'rename', 'appendFile'];
const FS_PROMISES_WRITERS = ['writeFile', 'rename', 'appendFile'];

// Lines the import-bound rule flags that are justified where they stand.
// `line` is the exact source line, trimmed.
const BOUND_CALL_EXCEPTIONS = [
  {
    path: 'packages/idea-engine/src/store/file-io.ts',
    line: "writeFileSync(fd, render(), 'utf8');",
    reason: "idea-engine's own staged write: the descriptor is a fresh staging file opened with 'wx'",
  },
  {
    path: 'packages/idea-engine/src/store/file-io.ts',
    line: 'renameSync(tempPath, path);',
    reason: "idea-engine's own staged write: commits that staging file; its store writes deliberately skip the directory fsync",
  },
  {
    path: 'packages/idea-engine/src/store/file-io.ts',
    line: "writeFileSync(fd, `${prefix}${JSON.stringify(payload)}\\n`, 'utf8');",
    reason: "appendJsonLine appends in place to the log at its own name, through a descriptor opened with 'a+'; like every in-place append, that open follows a link left at the log's name — a deferred same-class site, not a cleared one",
  },
  {
    path: 'packages/idea-engine/src/store/file-lock.ts',
    line: "writeFileSync(fd, JSON.stringify({ created_at: new Date().toISOString(), pid: process.pid }), 'utf8');",
    reason: "fills the lock file through the descriptor that created it with 'wx'",
  },
  {
    path: 'packages/rep-sdk/src/transport/file-transport.ts',
    line: "await appendFile(this.filePath, `${serializeEnvelope(validation.data)}\\n`, 'utf8');",
    reason: 'standalone SDK without workspace dependencies; its JSONL transport is documented as not crash-atomic',
  },
  {
    path: 'packages/hep-mcp/src/core/evidence.ts',
    line: "const out = fs.createWriteStream(catalogPath, { encoding: 'utf-8' });",
    reason: 'evidence catalog writer; the evidence tools are scheduled for removal',
  },
  {
    path: 'packages/hep-mcp/src/core/hep/measurements.ts',
    line: "const out = fs.createWriteStream(outPath, { encoding: 'utf-8' });",
    reason: 'run-artifact writer; hep-mcp run-artifact paths are being rewritten in a separate change',
  },
  {
    path: 'packages/hep-mcp/src/core/inspire/resolveIdentifiers.ts',
    line: "const out = fs.createWriteStream(mappingPath, { encoding: 'utf-8' });",
    reason: 'run-artifact writer; hep-mcp run-artifact paths are being rewritten in a separate change',
  },
  {
    path: 'packages/hep-mcp/src/core/inspire/searchExport.ts',
    line: "const out = fs.createWriteStream(exportPath, { encoding: 'utf-8' });",
    reason: 'run-artifact writer; hep-mcp run-artifact paths are being rewritten in a separate change',
  },
  {
    path: 'packages/hep-mcp/src/core/writing/latexCompileGate.ts',
    line: "const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'w' });",
    reason: 'run-artifact log stream; hep-mcp run-artifact paths are being rewritten in a separate change',
  },
  {
    path: 'packages/hep-mcp/src/core/writing/latexCompileGate.ts',
    line: "const stderrStream = fs.createWriteStream(stderrPath, { flags: 'w' });",
    reason: 'run-artifact log stream; hep-mcp run-artifact paths are being rewritten in a separate change',
  },
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writersFor(moduleName) {
  if (FS_MODULES.has(moduleName)) return FS_WRITERS;
  if (FS_PROMISES_MODULES.has(moduleName)) return FS_PROMISES_WRITERS;
  return null;
}

// Patterns for calls of fs writers through the bindings this file imports.
function importBoundPatterns(content) {
  const patterns = [];
  // import * as NAME from 'm'  /  import NAME from 'm'  /  import NAME, { ... } from 'm'
  for (const match of content.matchAll(/import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"]([^'"]+)['"]/g)) {
    const writers = writersFor(match[2]);
    if (!writers) continue;
    const name = escapeRegExp(match[1]);
    patterns.push(new RegExp(`(?<![\\w$.])${name}\\.(?:${writers.join('|')})\\s*\\(`));
    if (FS_MODULES.has(match[2])) {
      patterns.push(new RegExp(`(?<![\\w$.])${name}\\.promises\\.(?:${FS_PROMISES_WRITERS.join('|')})\\s*\\(`));
    }
  }
  // import { a, b as c } from 'm'  (also after a default import)
  for (const match of content.matchAll(/import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const writers = writersFor(match[2]);
    if (!writers) continue;
    for (const specifier of match[1].split(',').map(item => item.trim()).filter(Boolean)) {
      const parts = specifier.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (!parts) continue;
      const local = escapeRegExp(parts[2] ?? parts[1]);
      if (FS_MODULES.has(match[2]) && parts[1] === 'promises') {
        // `import { promises as fsp } from 'fs'` binds the fs/promises namespace.
        patterns.push(new RegExp(`(?<![\\w$.])${local}\\.(?:${FS_PROMISES_WRITERS.join('|')})\\s*\\(`));
        continue;
      }
      if (!writers.includes(parts[1])) continue;
      patterns.push(new RegExp(`(?<![\\w$.])${local}\\s*\\(`));
    }
  }
  return patterns;
}

function* walkProductionFiles(rootRel) {
  const rootAbs = path.join(repoRoot, rootRel);
  if (!existsSync(rootAbs)) return;
  const stack = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__' || entry.name === 'tests') {
        continue;
      }
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(childAbs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.[mc]?[jt]sx?$/.test(entry.name)) continue;
      yield childAbs;
    }
  }
}

function stripCommentsAndStrings(line) {
  // Conservative: remove `//`-style trailing comments and standalone string
  // literals so that comments documenting the prior `fs.writeFileSync(...)`
  // call (as we have in several migrated files) don't trigger false hits.
  // Block comments are handled at line granularity — multi-line block
  // comments containing `fs.writeFileSync` would still trigger; in that case
  // the author should rephrase the comment.
  let stripped = line;
  // Remove string contents first (rough — drops everything between balanced
  // quotes on a single line). This eliminates docstrings and string-literal
  // diagnostics that mention these tokens, and keeps a `//` or `/*` inside a
  // string (a URL, a glob) from hiding the code after it.
  stripped = stripped.replace(/"(?:\\.|[^"\\])*"/g, '""');
  stripped = stripped.replace(/'(?:\\.|[^'\\])*'/g, "''");
  stripped = stripped.replace(/`(?:\\.|[^`\\])*`/g, '``');
  // Remove block comment fragments closed on this line, then a line comment.
  // A `/*` left over opens a block comment that runs past this line.
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, '');
  const lineCommentIdx = stripped.indexOf('//');
  if (lineCommentIdx !== -1) {
    stripped = stripped.slice(0, lineCommentIdx);
  }
  return stripped;
}

function scanFile(absPath) {
  const relPath = path.relative(repoRoot, absPath).split(path.sep).join('/');
  if (ALLOWLIST.has(relPath)) return [];

  const content = readFileSync(absPath, 'utf-8');
  const boundPatterns = importBoundPatterns(content);
  const lines = content.split('\n');
  const hits = [];
  let inBlockComment = false;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    let line = lines[lineIdx];
    // Track multi-line block comments crudely.
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx === -1) continue;
      line = line.slice(endIdx + 2);
      inBlockComment = false;
    }
    // Judged on the stripped line, so a `/*` inside a string or after `//`
    // does not open a block comment.
    let code = stripCommentsAndStrings(line);
    const openIdx = code.indexOf('/*');
    if (openIdx !== -1) {
      code = code.slice(0, openIdx);
      inBlockComment = true;
    }
    const namespaced = FORBIDDEN_PATTERNS.find(pattern => pattern.test(code));
    if (namespaced) {
      hits.push({ line: lineIdx + 1, match: namespaced.source, text: line.trim(), bound: false });
      continue;
    }
    const bound = boundPatterns.find(pattern => pattern.test(code));
    if (bound) {
      hits.push({ line: lineIdx + 1, match: bound.source, text: line.trim(), bound: true });
    }
  }
  return hits.map(hit => ({ relPath, ...hit }));
}

function main() {
  const errors = [];
  const usedExceptions = new Set();
  for (const rootRel of SCANNED_ROOTS) {
    for (const absPath of walkProductionFiles(rootRel)) {
      const hits = scanFile(absPath);
      for (const hit of hits) {
        if (hit.bound) {
          const exception = BOUND_CALL_EXCEPTIONS.find(entry => (
            entry.path === hit.relPath && entry.line === hit.text && !usedExceptions.has(entry)
          ));
          if (exception) {
            usedExceptions.add(exception);
            continue;
          }
        }
        errors.push(
          `${hit.relPath}:${hit.line} — forbidden \`${hit.match}\`: ${hit.text}`,
        );
      }
    }
  }
  for (const exception of BOUND_CALL_EXCEPTIONS) {
    if (!usedExceptions.has(exception)) {
      errors.push(
        `${exception.path} — BOUND_CALL_EXCEPTIONS entry matches no flagged line any more; remove it: ${exception.line}`,
      );
    }
  }

  if (errors.length > 0) {
    process.stderr.write('[atomic-write-drift] forbidden bare fs write/rename/append calls in production code:\n\n');
    for (const error of errors) {
      process.stderr.write(`  ${error}\n`);
    }
    process.stderr.write(
      '\nUse one of the durable primitives from @nullius/shared instead:\n' +
      '  - writeBytesAtomicDurable(filePath, bytes, mode?)\n' +
      '  - writeChunksAtomicDurable(filePath, chunks, mode?)   (streamed content)\n' +
      '  - writeJsonAtomicDurable(filePath, payload, stringify?)\n' +
      '  - appendJsonlDurable(filePath, lineObject)\n' +
      '  - appendBytesDurable(filePath, bytes)\n' +
      '  - writeExecutableAtomicDurable(filePath, script)\n' +
      '  - commitStagedDurable(stagedPath, finalPath)\n' +
      '  - moveEntryDurable(fromPath, toPath)   (cross-parent durable move)\n' +
      '\nIf the new call site genuinely cannot use a primitive (e.g. cross-parent\n' +
      'rename inside an outer durably-committed staging area), add it to the\n' +
      'ALLOWLIST in scripts/check-atomic-write-anti-drift.mjs with a justification,\n' +
      'or, for an import-bound call, its exact line to BOUND_CALL_EXCEPTIONS with a reason.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('[ok] no bare fs.writeFileSync/renameSync/appendFileSync (or fs.promises.* variants) in production code paths.\n');
}

main();
