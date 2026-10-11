#!/usr/bin/env node
// Unreachable-module anti-drift.
//
// A source module that no declared package entry reaches is dead weight: it still
// builds, still carries tests, and still reads as if it were part of what the package
// does, while nothing can call it. Such modules pile up when a caller is deleted and
// the callee is left behind. This check walks the static relative imports of a
// package from the entries it declares in package.json (`main`, `module`, `types`,
// `bin`, every string leaf of `exports`) and fails when a module under the package's
// source root is not reached and is not on the package's explicit allowlist.
//
// What counts as an import (parsed with the TypeScript compiler, so comments and
// strings cannot fake or hide one): `import`/`export ... from`, side-effect `import`,
// `import x = require()`, `require()`, `import()` calls and `import()` types, each
// with a literal relative specifier. An `import()` whose argument is not a literal
// cannot be followed; in an enforced package that is reported as a failure rather
// than silently trusted.
//
// Specifier resolution follows the package's own build layout: a path under the
// tsconfig `outDir` (e.g. `./dist/index.js` in package.json or a `bin/` launcher) is
// mapped to the matching source file under `rootDir`, and the `.js`/`.mjs`/`.cjs`
// spellings resolve to their `.ts`/`.mts`/`.cts` sources.
//
// Modules that are not part of the source graph are not candidates: declaration
// files (`.d.ts`), test files (`*.test.*`, `*.spec.*`) and anything under a
// `__tests__`, `__mocks__` or `__fixtures__` directory.
//
// Allowlist entries are additional roots, not exemptions: a module that is started
// some other way (a shell launcher, a test-driven evaluation suite) is listed with the
// reason, and whatever it imports counts as reached. An entry that matches no file
// fails the check, so the list cannot outlive what it names.
//
// Usage:
//   node scripts/check-unreachable-modules.mjs            enforce the packages below
//   node scripts/check-unreachable-modules.mjs --report   also list every other package's count
//   node scripts/check-unreachable-modules.mjs --report --verbose   ...and name the modules

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Packages held to the check, keyed by repo-relative directory. Each allowlist entry is
// a repo-package-relative file path, or a directory prefix ending in '/'.
export const ENFORCED_PACKAGES = {
  'packages/hep-mcp': {
    allow: [
      // Evaluation substrate: driven by tests/eval/*.test.ts (vitest), not by the MCP
      // server. Kept as the designated place for semantic-quality evaluation.
      { path: 'src/eval/', reason: 'evaluation substrate run by tests/eval' },
      // Administrative command-line tools, started by scripts/*.sh from dist/admin/.
      { path: 'src/admin/cli-import-paper.ts', reason: 'started by scripts/import-paper.sh' },
      { path: 'src/admin/cli-link-kb-notes.ts', reason: 'started by scripts/link-kb-notes.sh' },
      { path: 'src/admin/cli-migrate-papers-cache.ts', reason: 'started by scripts/migrate-papers-cache.sh' },
      { path: 'src/admin/cli-prune-paper-cache.ts', reason: 'started by scripts/prune-paper-cache.sh' },
    ],
  },
};

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const EXCLUDED_DIRECTORIES = new Set(['__tests__', '__mocks__', '__fixtures__', 'node_modules']);
const RESOLUTION_ALTERNATIVES = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function loadTypeScript(repoRoot) {
  // The root manifest does not depend on typescript; every TypeScript workspace package
  // does, so borrow it from the first one that resolves it.
  const packagesDir = path.join(repoRoot, 'packages');
  const candidates = existsSync(packagesDir) ? readdirSync(packagesDir).sort() : [];
  for (const name of candidates) {
    const manifest = path.join(packagesDir, name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      return createRequire(manifest)('typescript');
    } catch {
      // try the next package
    }
  }
  throw new Error('typescript is not resolvable from any packages/*/package.json; run pnpm install first');
}

function isCandidateModule(relPath) {
  const base = path.posix.basename(relPath);
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return false;
  return SOURCE_EXTENSIONS.includes(path.posix.extname(base));
}

function listSourceModules(sourceRoot) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (entry.isFile() && isCandidateModule(toPosix(full))) {
        out.push(full);
      }
    }
  };
  if (existsSync(sourceRoot)) walk(sourceRoot);
  return out.sort();
}

function readLayout(packageDir) {
  // rootDir/outDir from the package's own tsconfig; a package without one is taken to
  // ship its sources directly from src/.
  const tsconfigPath = path.join(packageDir, 'tsconfig.json');
  let rootDir = 'src';
  let outDir = null;
  if (existsSync(tsconfigPath)) {
    const options = JSON.parse(readFileSync(tsconfigPath, 'utf8')).compilerOptions ?? {};
    if (typeof options.rootDir === 'string') rootDir = options.rootDir;
    if (typeof options.outDir === 'string') outDir = options.outDir;
  }
  return {
    sourceRoot: path.resolve(packageDir, rootDir),
    outRoot: outDir === null ? null : path.resolve(packageDir, outDir),
  };
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveTarget(target, layout) {
  // Map a build-output path back to its source, then try the source spellings.
  let p = target;
  if (layout.outRoot !== null && isWithin(p, layout.outRoot)) {
    p = path.join(layout.sourceRoot, path.relative(layout.outRoot, p));
    // A `types` entry names the emitted declaration; its source is the module itself.
    p = p.replace(/\.d\.([cm]?ts)$/, '.$1');
  }
  const ext = path.extname(p);
  const tries = [];
  if (RESOLUTION_ALTERNATIVES[ext]) {
    const stem = p.slice(0, -ext.length);
    for (const alt of RESOLUTION_ALTERNATIVES[ext]) tries.push(stem + alt);
  } else if (ext === '') {
    tries.push(p);
    for (const alt of SOURCE_EXTENSIONS) tries.push(p + alt);
    for (const alt of SOURCE_EXTENSIONS) tries.push(path.join(p, 'index' + alt));
  } else {
    tries.push(p);
  }
  return tries.find(isFile) ?? null;
}

function collectSpecifiers(ts, file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const nonLiteral = [];
  const literalOf = node =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const lineOf = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const spec = literalOf(node.moduleSpecifier);
      if (spec !== null) specifiers.push(spec);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literalOf(node.moduleReference.expression);
      if (spec !== null) specifiers.push(spec);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const spec = literalOf(node.arguments[0]);
        if (spec !== null) specifiers.push(spec);
        else if (isDynamicImport) nonLiteral.push(lineOf(node));
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const spec = literalOf(node.argument.literal);
      if (spec !== null) specifiers.push(spec);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, nonLiteral };
}

function collectEntryPaths(manifest) {
  const out = [];
  const leaves = value => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(leaves);
    else if (value && typeof value === 'object') Object.values(value).forEach(leaves);
  };
  for (const field of ['main', 'module', 'types', 'typings', 'bin', 'exports']) leaves(manifest[field]);
  return [...new Set(out)];
}

function matchesAllow(relPath, allow) {
  return allow.path.endsWith('/') ? relPath.startsWith(allow.path) : relPath === allow.path;
}

export function scanPackage(packageDir, { allow = [], ts } = {}) {
  const typescript = ts ?? loadTypeScript(scriptRepoRoot);
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const layout = readLayout(packageDir);
  const modules = listSourceModules(layout.sourceRoot);
  const rel = p => toPosix(path.relative(packageDir, p));

  const problems = [];
  const roots = [];
  for (const entry of collectEntryPaths(manifest)) {
    if (entry.includes('*')) {
      problems.push(`package.json entry ${entry} is a pattern; this check does not expand patterns`);
      continue;
    }
    const resolved = resolveTarget(path.resolve(packageDir, entry), layout);
    if (resolved === null) problems.push(`package.json entry ${entry} does not resolve to a source file`);
    else roots.push(resolved);
  }
  const declaredRootCount = roots.length;
  for (const item of allow) {
    const matched = modules.filter(m => matchesAllow(rel(m), item));
    if (matched.length === 0) problems.push(`allowlist entry ${item.path} matches no source module`);
    roots.push(...matched);
  }
  if (declaredRootCount === 0) problems.push('package.json declares no entry that resolves to a source file');

  const reached = new Set();
  const queue = [...roots];
  const nonLiteralSites = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    if (!SOURCE_EXTENSIONS.includes(path.extname(file))) continue;
    const { specifiers, nonLiteral } = collectSpecifiers(typescript, file);
    for (const line of nonLiteral) nonLiteralSites.push(`${rel(file)}:${line}`);
    for (const spec of specifiers) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const target = resolveTarget(path.resolve(path.dirname(file), spec), layout);
      if (target === null) problems.push(`${rel(file)} imports ${spec}, which does not resolve to a file`);
      else if (!reached.has(target)) queue.push(target);
    }
  }
  for (const site of nonLiteralSites) {
    problems.push(`${site} has an import() with a non-literal argument; its target cannot be followed`);
  }

  const unreachable = modules.filter(m => !reached.has(m)).map(rel);
  return { modules: modules.length, reached: modules.filter(m => reached.has(m)).length, unreachable, problems };
}

function listWorkspacePackages(repoRoot) {
  const packagesDir = path.join(repoRoot, 'packages');
  return readdirSync(packagesDir)
    .filter(name => existsSync(path.join(packagesDir, name, 'package.json')))
    .sort()
    .map(name => `packages/${name}`);
}

export function runCheck({ repoRoot = scriptRepoRoot, enforced = ENFORCED_PACKAGES, report = false, verbose = false } = {}) {
  const ts = loadTypeScript(scriptRepoRoot);
  const lines = [];
  let failed = false;
  for (const [pkg, config] of Object.entries(enforced)) {
    const packageDir = path.join(repoRoot, pkg);
    if (!existsSync(path.join(packageDir, 'package.json'))) {
      failed = true;
      lines.push(`FAIL ${pkg}: enforced package has no package.json`);
      continue;
    }
    const result = scanPackage(packageDir, { allow: config.allow, ts });
    if (result.unreachable.length === 0 && result.problems.length === 0) {
      lines.push(`ok ${pkg}: all ${result.modules} source modules reached from declared entries or allowlisted roots`);
      continue;
    }
    failed = true;
    lines.push(`FAIL ${pkg}:`);
    for (const problem of result.problems) lines.push(`  ${problem}`);
    if (result.unreachable.length > 0) {
      lines.push(`  ${result.unreachable.length} source module(s) reached by no declared entry and not allowlisted:`);
      for (const m of result.unreachable) lines.push(`    ${m}`);
      lines.push('  Wire each one into a live path, delete it, or add it to the allowlist in');
      lines.push('  scripts/check-unreachable-modules.mjs with the reason it is started some other way.');
    }
  }
  if (report) {
    for (const pkg of listWorkspacePackages(repoRoot)) {
      if (Object.hasOwn(enforced, pkg)) continue;
      const packageDir = path.join(repoRoot, pkg);
      const result = scanPackage(packageDir, { ts });
      const notes = result.problems.length > 0 ? `; ${result.problems.length} note(s)` : '';
      lines.push(`report ${pkg}: ${result.unreachable.length} of ${result.modules} source modules unreached${notes}`);
      if (verbose) {
        for (const problem of result.problems) lines.push(`  note: ${problem}`);
        for (const m of result.unreachable) lines.push(`    ${m}`);
      }
    }
  }
  return { failed, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const { failed, lines } = runCheck({ report: args.has('--report'), verbose: args.has('--verbose') });
  for (const line of lines) (failed ? console.error : console.log)(`[unreachable-modules] ${line}`);
  process.exit(failed ? 1 : 0);
}
