import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatReport, scanContent, scanRepository, sensitiveFileName } from '../check-portable-paths-anti-drift.mjs';

const homePath = user => ['', 'Users', user, 'project'].join('/');
const privateUser = 'private-researcher-37';
const syntheticToken = () => 'ghp_' + 'A1b2C3d4E5f6'.repeat(3);

function repository(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-privacy-gate-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (name, content) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const add = name => execFileSync('git', ['add', '--', name], { cwd: root });
  return { base, root, write, add };
}

test('scans tracked and unignored new tests/scripts/formats without reading ignored files', t => {
  const repo = repository(t);
  repo.write('.gitignore', 'ignored/\n');
  repo.write('tests/tracked.test.ts', homePath(privateUser));
  repo.add('tests/tracked.test.ts');
  repo.write('new configuration.toml', homePath(privateUser));
  repo.write('scripts/check-portable-paths-anti-drift.mjs', homePath(privateUser));
  // NTFS refuses control characters in file names; Unicode and spaces still
  // exercise the native git -z enumeration boundary.
  const unusualName = process.platform === 'win32' ? 'tests/name with-tab-研究.yaml' : 'tests/name\nwith-tab\t.yaml';
  repo.write(unusualName, homePath(privateUser));
  repo.write('ignored/private.md', homePath(privateUser));
  const result = scanRepository(repo.root);
  assert.deepEqual(result.violations.map(item => item.file).sort(), [
    'new configuration.toml', 'scripts/check-portable-paths-anti-drift.mjs',
    unusualName, 'tests/tracked.test.ts',
  ]);
  assert.ok(result.violations.every(item => item.rule === 'machine-home-path' && item.line === 1));
  assert.ok(formatReport(result).includes(process.platform === 'win32' ? 'name with-tab-研究.yaml' : 'name\\nwith-tab\\t.yaml'));
  const controlNameReport = formatReport({ files: 1, violations: [{ file: 'name\nwith-tab\t.yaml', line: 1, rule: 'machine-home-path' }] });
  assert.ok(controlNameReport.includes('name\\nwith-tab\\t.yaml'));
});

test('already tracked files stay checked after a new ignore rule; working-tree deletions are safe', t => {
  const repo = repository(t);
  repo.write('tracked.json', homePath(privateUser));
  repo.add('tracked.json');
  repo.write('.gitignore', '*.json\n');
  assert.equal(scanRepository(repo.root).violations.length, 1);
  fs.unlinkSync(path.join(repo.root, 'tracked.json'));
  assert.deepEqual(scanRepository(repo.root).violations, []);
});

test('embedded repositories and gitlinks retain their own source boundary', t => {
  const repo = repository(t);
  const nested = path.join(repo.root, 'nested');
  fs.mkdirSync(nested);
  execFileSync('git', ['init', '-q', nested]);
  fs.writeFileSync(path.join(nested, '.gitignore'), 'private.txt\n');
  fs.writeFileSync(path.join(nested, 'private.txt'), syntheticToken());
  fs.writeFileSync(path.join(nested, 'public.md'), 'fixture');
  const expected = [{ file: 'nested', line: 1, rule: 'unsupported-file-type' }];
  assert.deepEqual(scanRepository(repo.root).violations, expected);
  execFileSync('git', ['add', '.'], { cwd: nested });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: nested });
  execFileSync('git', ['-c', 'advice.addEmbeddedRepo=false', 'add', 'nested'], { cwd: repo.root });
  assert.deepEqual(scanRepository(repo.root).violations, expected);
  fs.renameSync(path.join(nested, '.git'), path.join(repo.base, 'nested-metadata'));
  assert.deepEqual(scanRepository(repo.root).violations, expected, 'an uninitialized gitlink stays a single entry');
});

test('a tracked file replaced by a directory is refused without scanning its contents', t => {
  const repo = repository(t);
  repo.write('tracked', 'fixture');
  repo.add('tracked');
  fs.unlinkSync(path.join(repo.root, 'tracked'));
  fs.mkdirSync(path.join(repo.root, 'tracked'));
  fs.writeFileSync(path.join(repo.root, 'tracked', 'private.txt'), syntheticToken());
  assert.deepEqual(scanRepository(repo.root).violations, [{ file: 'tracked', line: 1, rule: 'unsupported-file-type' }]);
});

test('file URIs, encoded names, Linux, Unicode and escaped Windows paths are not loopholes', () => {
  const windows = ['C:', 'Users', privateUser, 'project'].join('\\');
  for (const candidate of [
    homePath(privateUser), 'file://' + homePath(privateUser),
    'file://' + homePath(privateUser).replace('private', '%70rivate'),
    ['', 'home', privateUser].join('/'), homePath('研究账户'),
    windows, windows.replaceAll('\\', '\\\\'), windows.replaceAll('\\', '/'),
  ]) {
    assert.equal(scanContent('tests/example.test.ts', candidate).length, 1);
  }
});

test('only explicit generic fixture usernames are exempt; a test directory never exempts real accounts', () => {
  assert.deepEqual(scanContent('tests/redaction.test.ts', [homePath('alice'), homePath('ubuntu'), homePath('old-machine'), homePath('test-researcher')].join('\n')), []);
  assert.equal(scanContent('README.md', homePath('alice')).length, 1);
  assert.equal(scanContent('tests/redaction.test.ts', homePath(privateUser)).length, 1);
  assert.deepEqual(scanContent('README.md', [
    '/Users/<user>/project', '$HOME/project', './relative/project',
    'https://example.org' + homePath(privateUser),
    'Author: Example Researcher; https://github.com/example/project',
  ].join('\n')), []);
});

test('sensitive environment/auth filenames are rejected even with innocuous contents', t => {
  const repo = repository(t);
  const names = ['.env', '.envrc', '.env.production', '.netrc', '.npmrc', 'auth.json', 'credentials.yaml', 'secrets.toml', '.aws/credentials', '.docker/config.json', '.ssh/config', '.kube/config', 'id_ed25519', 'private.pem', 'runtime/.gemini/oauth_creds.json', 'runtime/.gemini/oauth_credentials.json', 'runtime/.gemini/google_accounts.json', 'oauth-tokens.json', '.oauth.json', 'uppercase/.gemini/Google_Accounts.JSON', 'uppercase/.gemini/OAuth_Creds.JSON'];
  for (const name of names) repo.write(name, 'placeholder only\n');
  assert.deepEqual(scanRepository(repo.root).violations.map(item => item.file).sort(), names.sort());
  for (const name of ['.env.example', 'credentials.example.json', 'oauth_creds.example.json', 'secret.template', 'src/auth.ts']) assert.equal(sensitiveFileName(name), false);
});

test('high-confidence secret material is rejected in tests and templates without printing values', t => {
  const repo = repository(t);
  const tokens = [
    syntheticToken(), 'github_pat_' + 'A1b2C3d4E5f6'.repeat(6),
    'AKIA' + 'A1B2C3D4'.repeat(2), 'sk-proj-' + 'abcdef1234'.repeat(5),
    'sk-ant-' + 'abcdef1234'.repeat(5), 'sk_live_' + 'abcDEF123456'.repeat(3),
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
    ['-----BEGIN', 'ENCRYPTED PRIVATE KEY-----'].join(' '),
    ['-----BEGIN', 'PGP PRIVATE KEY BLOCK-----'].join(' '),
  ];
  repo.write('tests/credential-fixture.test.ts', tokens.join('\n'));
  repo.write('credentials.example.json', syntheticToken());
  const result = scanRepository(repo.root);
  assert.equal(result.violations.length, tokens.length + 1);
  const report = formatReport(result);
  for (const value of tokens) assert.ok(!report.includes(value));
  assert.deepEqual(scanContent('tests/redaction.test.ts', ['sk-test-example', 'sk-longkey'.repeat(3), 'dummy-api-key', 'YOUR_API_KEY'].join('\n')), []);
  const tokenFileReport = formatReport({ files: 1, violations: [{ file: syntheticToken() + '.txt', line: 1, rule: 'private-key' }] });
  assert.ok(!tokenFileReport.includes(syntheticToken()));
});

test('checks symlink targets without following them to external private data', t => {
  const repo = repository(t);
  const outside = path.join(repo.base, 'outside.txt');
  if (process.platform === 'win32') {
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'private.txt'), syntheticToken());
  } else fs.writeFileSync(outside, syntheticToken());
  fs.symlinkSync(outside, path.join(repo.root, 'safe-link'), process.platform === 'win32' ? 'junction' : 'file');
  const safeLinkViolations = scanContent('safe-link', fs.readlinkSync(path.join(repo.root, 'safe-link')));
  assert.deepEqual(scanRepository(repo.root).violations, safeLinkViolations);
  fs.symlinkSync(process.platform === 'win32' ? 'C:' + homePath(privateUser) : homePath(privateUser), path.join(repo.root, 'private-link'), process.platform === 'win32' ? 'junction' : 'file');
  assert.deepEqual(scanRepository(repo.root).violations, [{ file: 'private-link', line: 1, rule: 'machine-home-path' }, ...safeLinkViolations]);
});

test('does not hide ASCII leaks in binary files or UTF-16LE text', t => {
  const repo = repository(t);
  repo.write('unknown-format.blob', Buffer.from('\0' + homePath(privateUser)));
  repo.write('windows.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(homePath(privateUser), 'utf16le')]));
  assert.deepEqual(scanRepository(repo.root).violations.map(item => item.file), ['unknown-format.blob', 'windows.txt']);
});
