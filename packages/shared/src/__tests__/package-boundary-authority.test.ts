import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function repoRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..');
}

function collectTsFiles(dirPath: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
  return out.sort((left, right) => left.localeCompare(right));
}

/**
 * Workspace package names may appear in shared source only as data compared
 * for equality (for example a package name read from a manifest). Every
 * other string literal naming one (`@nullius/<name>`) is reported, whether it
 * sits at a module resolution site (import and re-export declarations,
 * `import x = require()`, `import()` in value or type position, `require()`,
 * `require.resolve()`, `module.require()`, `import.meta.resolve()`, ambient
 * module declarations) or anywhere else a resolver could later receive it;
 * so is a triple-slash reference to a workspace package. A resolution call
 * whose specifier is not a literal is reported, because what it loads cannot
 * be checked here, and so is `createRequire`, which hands out a resolver
 * under any name.
 */
function findWorkspaceImports(filePath: string, source: string): string[] {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: string[] = [];
  const at = (position: number) => `L${file.getLineAndCharacterOfPosition(position).line + 1}`;
  const isLiteral = (node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
  const resolvesModule = (call: ts.CallExpression): boolean => {
    const callee = call.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (ts.isIdentifier(callee)) return callee.text === 'require';
    if (!ts.isPropertyAccessExpression(callee)) return false;
    let root: ts.Expression = callee;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    return (ts.isIdentifier(root) && root.text === 'require')
      || (ts.isIdentifier(callee.expression) && callee.expression.text === 'module' && callee.name.text === 'require')
      || (ts.isMetaProperty(callee.expression) && callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword
        && callee.name.text === 'resolve');
  };
  const workspacePackage = /^@nullius\/./;
  const equality = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);
  const comparedAsData = (literal: ts.Node): boolean => {
    const parent = literal.parent;
    return (ts.isBinaryExpression(parent) && equality.has(parent.operatorToken.kind))
      || (ts.isCaseClause(parent) && parent.expression === literal);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && resolvesModule(node) && !isLiteral(node.arguments[0])) {
      offenders.push(`${at(node.getStart(file))}:<non-literal module specifier>`);
    } else if (ts.isIdentifier(node) && node.text === 'createRequire') {
      offenders.push(`${at(node.getStart(file))}:<createRequire>`);
    } else if (isLiteral(node) && workspacePackage.test(node.text) && !comparedAsData(node)) {
      offenders.push(`${at(node.getStart(file))}:${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const reference of [...file.referencedFiles, ...file.typeReferenceDirectives]) {
    if (workspacePackage.test(reference.fileName)) offenders.push(`${at(reference.pos)}:${reference.fileName}`);
  }
  return offenders;
}

function workspaceDependencies(packageJsonPath: string): string[] {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
  const dependencyGroups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const offenders: string[] = [];
  for (const group of dependencyGroups) {
    const entries = packageJson[group];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const name of Object.keys(entries)) {
      if (name.startsWith('@nullius/')) {
        offenders.push(`${group}:${name}`);
      }
    }
  }
  return offenders.sort((left, right) => left.localeCompare(right));
}

describe('shared package boundary authority', () => {
  it('keeps shared source free of workspace package imports', () => {
    const repoRoot = repoRootFromThisFile();
    const srcRoot = path.join(repoRoot, 'packages', 'shared', 'src');
    const offenders = collectTsFiles(srcRoot).flatMap(filePath => {
      const matches = findWorkspaceImports(filePath, fs.readFileSync(filePath, 'utf-8'));
      const relPath = path.relative(repoRoot, filePath);
      return matches.map(match => `${relPath}:${match}`);
    });

    expect(offenders).toEqual([]);
  });

  it('reports every resolution form and every package name not compared as data', () => {
    const source = [
      '/// <reference types="@nullius/referenced" />',
      "import { a } from '@nullius/orchestrator';",
      "import type { B } from '@nullius/hep-mcp/types';",
      "export * from '@nullius/idea-engine';",
      "import '@nullius/side-effect';",
      "import legacy = require('@nullius/legacy');",
      "const lazy = await import('@nullius/lazy');",
      "type T = import('@nullius/typed').T;",
      'const cjs = require(`@nullius/template`);',
      "declare module '@nullius/augmented' {}",
      "const resolved = require.resolve('@nullius/resolved');",
      "const viaModule = module.require('@nullius/module-required');",
      "const viaMeta = import.meta.resolve('@nullius/meta-resolved');",
      'const computed = await import(name);',
      'const computedResolve = require.resolve.paths(name);',
      'const load = createRequire(import.meta.url);',
      "const asData = '@nullius/as-data';",
      "if (manifest.name === '@nullius/orchestrator') {}",
      "switch (manifest.name) { case '@nullius/shared': break; }",
      "// see '@nullius/in-comment'",
      "const local = await import('./local.js');",
    ].join('\n');
    expect(findWorkspaceImports('fixture.ts', source)).toEqual([
      'L2:@nullius/orchestrator',
      'L3:@nullius/hep-mcp/types',
      'L4:@nullius/idea-engine',
      'L5:@nullius/side-effect',
      'L6:@nullius/legacy',
      'L7:@nullius/lazy',
      'L8:@nullius/typed',
      'L9:@nullius/template',
      'L10:@nullius/augmented',
      'L11:@nullius/resolved',
      'L12:@nullius/module-required',
      'L13:@nullius/meta-resolved',
      'L14:<non-literal module specifier>',
      'L15:<non-literal module specifier>',
      'L16:<createRequire>',
      'L17:@nullius/as-data',
      'L1:@nullius/referenced',
    ]);
  });

  it('keeps shared package.json free of workspace package dependencies', () => {
    const repoRoot = repoRootFromThisFile();
    const packageJsonPath = path.join(repoRoot, 'packages', 'shared', 'package.json');
    expect(workspaceDependencies(packageJsonPath)).toEqual([]);
  });
});
