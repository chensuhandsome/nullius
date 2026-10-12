// Per-run temporary root for the vitest suites (wired as `globalSetup` in
// every package's vitest config).
//
// Before any worker starts, TMPDIR/TMP/TEMP are pointed at one fresh
// directory <original tmpdir>/ntest-<uid>/<package[:6]>-<pid>-XXXXXX (per
// user, so a shared /tmp never mixes owners), so every os.tmpdir() call in
// tests (and in child processes they spawn) lands inside it. The names are
// deliberately short: tools create Unix-domain sockets under TMPDIR, and a
// socket path longer than about 104 bytes (macOS) cannot be bound. At teardown
// the root is removed only when the run is known to have passed: every test
// finished (passed, skipped, or todo), nothing failed, the run was not being
// cancelled (Ctrl-C in watch mode), the command's exit status is still clean
// (vitest sets it before teardown, e.g. for a coverage threshold, and never
// resets it), and no earlier rerun of a watch session ended unclean. A
// failing, interrupted, or unreadable run keeps it for inspection, even when
// empty; the one exception is a clean command (not cancelled, clean exit
// status) in which no test ran at all (e.g. `vitest list`) and which left the
// root empty: it is removed silently, since there is nothing to inspect.
// Kept roots whose newest entry is older than the retention window, and whose
// creating process is no longer alive, are swept when a later run starts, but
// only roots that carry this module's origin marker (a regular file written at
// creation with exactly the expected content): a directory that merely matches
// the name pattern, or whose marker is missing, altered, a symlink, or not a
// regular file, is never deleted.
// NULLIUS_KEEP_TEST_TMP=1 keeps every root: the run's own and, since no sweep
// runs in that mode, every earlier one.
//
// Cleanup problems never fail a test run: they are reported on stderr.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_RUNS_PARENT_PREFIX = 'ntest';
const PARENT_README = 'Per-run temporary roots of the nullius test suites '
  + '(scripts/lib/vitest-test-temp-root.mjs). A passing run removes its root; a failing run keeps it, '
  + 'and roots unchanged for 7 days whose creating process has exited are removed by a later run, '
  + 'only when they carry the origin marker file written at creation. '
  + 'NULLIUS_KEEP_TEST_TMP=1 keeps every root.\n';

/** Origin marker written into every root at creation; the sweep deletes nothing without it. */
export const ROOT_MARKER = '.nullius-test-root';
const MARKER_MAX_BYTES = 256;

export function rootMarkerText(pid) {
  return `nullius test temp root\npid ${pid}\n`;
}

/** True only when `dir` holds this module's marker for `pid`: a regular file
 *  (never followed through a symlink) whose content is exactly the expected text. */
export function hasRootMarker(dir, pid) {
  let fd;
  try {
    // O_NONBLOCK: opening a FIFO at the marker path must not wait for a writer.
    fd = fs.openSync(path.join(dir, ROOT_MARKER),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    // A non-regular marker could never supply the exact text either; refuse it before reading.
    if (!stat.isFile() || stat.size > MARKER_MAX_BYTES) return false;
    return fs.readFileSync(fd, 'utf-8') === rootMarkerText(pid);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Create (or accept) the per-user parent only as a real directory owned by
 *  this user with mode 0700; a planted symlink or someone else's directory
 *  in a shared /tmp is refused rather than used. */
export function ensurePrivateParent(parent) {
  try {
    fs.mkdirSync(parent, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(parent);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) {
    throw new Error(`[test-temp-root] ${parent} is not a directory owned by this user; refusing to use it. `
      + 'Remove it (or hand it to this user with chown), then run the tests again.');
  }
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(parent, 0o700);
  return parent;
}

export function testRunsParent(baseTmp = os.tmpdir()) {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return path.join(baseTmp, `${TEST_RUNS_PARENT_PREFIX}-${uid}`);
}
export const RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Only directories this module created are ever swept; the pid of the run
// that created a root is part of its name.
const ROOT_NAME_PATTERN = /^[A-Za-z0-9._]{1,6}-(\d+)-[A-Za-z0-9]{6}$/;

/** True when a process with this pid exists (a live watch session keeps its
 *  root however long it idles; a reused pid only delays the sweep). */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function warn(message) {
  process.stderr.write(`[test-temp-root] ${message}\n`);
}

/** Remove a tree; on permission errors (tests that chmod directories
 *  read-only for fault injection) restore owner write bits and retry once. */
export function removeTree(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    try {
      const stack = [root];
      while (stack.length > 0) {
        const dir = stack.pop();
        let stat;
        try {
          stat = fs.lstatSync(dir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        try {
          fs.chmodSync(dir, 0o700);
        } catch {
          // keep going; the retry below reports what could not be removed
        }
        for (const entry of fs.readdirSync(dir)) stack.push(path.join(dir, entry));
      }
      fs.rmSync(root, { recursive: true, force: true });
      return true;
    } catch (error) {
      warn(`could not remove ${root}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

/** Newest modification time anywhere in a tree (the tree itself included).
 *  Anything that cannot be read counts as just modified (Infinity), so a
 *  tree that cannot be fully inspected is never judged old. */
export function newestMtime(root) {
  let newest = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return Infinity;  // vanished or unreadable meanwhile: something is still happening here
    }
    newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      return Infinity;
    }
    for (const entry of entries) stack.push(path.join(current, entry));
  }
  return newest;
}

/** Delete kept run roots under `parent` in which nothing has been modified
 *  for longer than the retention window. Returns the removed paths. */
export function sweepStaleRoots(parent, { now = Date.now(), retentionDays = RETENTION_DAYS, isAlive = processAlive } = {}) {
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const match = entry.isDirectory() ? ROOT_NAME_PATTERN.exec(entry.name) : null;
    if (!match) continue;
    if (isAlive(Number(match[1]))) continue;
    const full = path.join(parent, entry.name);
    if (!hasRootMarker(full, match[1])) continue;  // not positively ours: never deleted
    const newest = newestMtime(full);
    if (now - newest <= retentionDays * DAY_MS) continue;
    if (removeTree(full)) {
      removed.push(full);
    } else if (fs.existsSync(full) && !hasRootMarker(full, match[1])) {
      // A half-finished removal may have taken the marker: put it back, so the
      // root is tried again once it has been unchanged for the retention window,
      // instead of being skipped forever as unmarked.
      try {
        fs.writeFileSync(path.join(full, ROOT_MARKER), rootMarkerText(match[1]), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        warn(`could not restore the marker of ${full}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return removed;
}

const FINISHED_STATES = ['pass', 'skip', 'todo'];

function readableState(project) {
  const state = project?.vitest?.state;
  if (!state
    || typeof state.getCountOfFailedTests !== 'function'
    || typeof state.getFailedFilepaths !== 'function'
    || typeof state.getUnhandledErrors !== 'function'
    || typeof state.getFiles !== 'function') {
    return null;
  }
  return state;
}

/** A task finished when it was skipped or marked todo, or when it ended in a
 *  finished state and so did every task inside it (a cancelled run leaves
 *  tests that never started without a result inside files marked 'pass'). */
function taskFinished(task) {
  if (task?.mode === 'skip' || task?.mode === 'todo') return true;
  if (!FINISHED_STATES.includes(task?.result?.state)) return false;
  return !Array.isArray(task.tasks) || task.tasks.every(taskFinished);
}

function taskStarted(task) {
  return task?.result?.state !== undefined || (Array.isArray(task?.tasks) && task.tasks.some(taskStarted));
}

function exitStatusClean() {
  const code = process.exitCode;
  return code === undefined || code === null || Number(code) === 0;
}

/** True only when the vitest state positively reports a clean run. Any
 *  missing accessor (an API change) counts as "not known to have passed",
 *  so the root is kept rather than deleted. */
export function runPassed(project) {
  try {
    if (project?.vitest?.isCancelling === true || !exitStatusClean()) return false;
    const state = readableState(project);
    if (!state) return false;
    const files = state.getFiles();
    if (files.length === 0) return false;
    return files.every(taskFinished)
      && state.getCountOfFailedTests() === 0
      && state.getFailedFilepaths().length === 0
      && state.getUnhandledErrors().length === 0;
  } catch {
    return false;
  }
}

/** True only when the state positively shows that no test (and no file)
 *  started and nothing failed, as in a listing command. */
export function noTestRan(project) {
  try {
    const state = readableState(project);
    if (!state) return false;
    return !state.getFiles().some(taskStarted)
      && state.getCountOfFailedTests() === 0
      && state.getFailedFilepaths().length === 0
      && state.getUnhandledErrors().length === 0;
  } catch {
    return false;
  }
}

/** Empty apart from this module's own marker. */
function isEmptyDirectory(dir) {
  try {
    return fs.readdirSync(dir).every(name => name === ROOT_MARKER);
  } catch {
    return false;
  }
}

export default function setup(project) {
  const parent = ensurePrivateParent(testRunsParent());
  try {
    fs.writeFileSync(path.join(parent, 'README.txt'), PARENT_README, { flag: 'wx' });
  } catch {
    // already present
  }
  if (process.env.NULLIUS_KEEP_TEST_TMP !== '1') sweepStaleRoots(parent);

  const label = path.basename(project?.config?.root ?? process.cwd()).replace(/[^A-Za-z0-9._]/g, '').slice(0, 6) || 'tests';
  const root = fs.mkdtempSync(path.join(parent, `${label}-${process.pid}-`));
  try {
    fs.writeFileSync(path.join(root, ROOT_MARKER), rootMarkerText(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Without its marker the root is simply never swept; the run itself is unaffected.
    warn(`could not mark ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  // A watch session reruns tests with the same root: when a rerun starts, the
  // state still holds the previous run, and one unclean run keeps the root.
  let earlierRunUnclean = false;
  try {
    if (typeof project?.onTestsRerun === 'function') {
      project.onTestsRerun(() => {
        if (!runPassed(project)) earlierRunUnclean = true;
      });
    }
  } catch {
    earlierRunUnclean = true;  // cannot follow reruns: never treat a later clean state as the whole story
  }

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (process.env.NULLIUS_KEEP_TEST_TMP === '1') {
      warn(`kept ${root} (NULLIUS_KEEP_TEST_TMP=1)`);
      return;
    }
    if (earlierRunUnclean || !runPassed(project)) {
      // Only a clean command (not cancelled, clean exit status) in which nothing ran and nothing was
      // written; an interrupted or failed run keeps even an empty root, as documented above.
      if (!earlierRunUnclean && project?.vitest?.isCancelling !== true && exitStatusClean()
        && noTestRan(project) && isEmptyDirectory(root)) {
        removeTree(root);  // nothing ran and nothing was written: nothing to inspect
        return;
      }
      warn(`run did not pass; kept ${root} (swept after ${RETENTION_DAYS} days without changes)`);
      return;
    }
    removeTree(root);
  };
}
