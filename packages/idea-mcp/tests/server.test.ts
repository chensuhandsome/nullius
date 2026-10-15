import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoLegacyIdeaEnv,
  createIdeaRpcClient,
  isWithinRepoRoot,
  parseAndCleanToolArgs,
  resolveIdeaDataDir,
} from '../src/server.js';
import { IDEA_TOOLS } from '../src/tool-registry.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/** The repo spelled with swapped letter case when the filesystem folds case, else null. */
const CASE_FOLDING_REPO_SPELLING = (() => {
  const swapped = REPO_ROOT.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  return swapped !== REPO_ROOT && existsSync(swapped) ? swapped : null;
})();

function getTool(name: string) {
  const tool = IDEA_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function initParams(campaignName: string) {
  return {
    budget: {
      max_cost_usd: 100,
      max_steps: 5,
      max_tokens: 10_000,
      max_wall_clock_s: 3600,
    },
    charter: {
      approval_gate_ref: 'gate://idea.server',
      campaign_name: campaignName,
      domain: 'test-domain',
      scope: 'idea-mcp server wiring regression',
    },
    idempotency_key: `${campaignName}-init`,
    seed_pack: {
      seeds: [{ content: 'seed-a', seed_type: 'text' }],
    },
  };
}

describe('idea-mcp server configuration', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when IDEA_MCP_DATA_DIR is missing', () => {
    expect(() => resolveIdeaDataDir({})).toThrow(
      'idea-mcp requires IDEA_MCP_DATA_DIR; repo-local default data roots are forbidden',
    );
  });

  it('resolves explicit data dir overrides', () => {
    expect(resolveIdeaDataDir({ IDEA_MCP_DATA_DIR: join(tmpdir(), 'idea-runs') })).toContain('/idea-runs');
  });

  it('rejects repo-local data dir overrides', () => {
    expect(() => resolveIdeaDataDir({ IDEA_MCP_DATA_DIR: 'packages/idea-engine/runs' })).toThrow(
      'idea-mcp requires IDEA_MCP_DATA_DIR outside the dev repo:',
    );
    expect(() => resolveIdeaDataDir({
      IDEA_MCP_DATA_DIR: resolve(import.meta.dirname, '../../idea-engine/runs'),
    })).toThrow('idea-mcp requires IDEA_MCP_DATA_DIR outside the dev repo:');
  });

  it('rejects a repo-local data dir whose name begins with two dots', () => {
    // `<repo>/..data` is inside the repo; a prefix test on '..' reads it as outside.
    expect(() => resolveIdeaDataDir({ IDEA_MCP_DATA_DIR: join(REPO_ROOT, '..idea-data') })).toThrow(
      'idea-mcp requires IDEA_MCP_DATA_DIR outside the dev repo:',
    );
  });

  it('rejects a data dir that reaches the repo through a symlinked alias', () => {
    // The alias is built explicitly, so this discriminates even where the
    // temp directory itself is not reached through a symlink (Linux /tmp).
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'idea-mcp-alias-')));
    tempDirs.push(outside);
    symlinkSync(REPO_ROOT, join(outside, 'repo-alias'), 'dir');
    symlinkSync(join(REPO_ROOT, 'packages'), join(outside, 'packages-alias'), 'dir');

    for (const dataDir of [
      join(outside, 'repo-alias'),
      join(outside, 'repo-alias', 'idea-data'),
      join(outside, 'packages-alias', 'idea-engine', 'runs'),
    ]) {
      expect(() => resolveIdeaDataDir({ IDEA_MCP_DATA_DIR: dataDir })).toThrow(
        'idea-mcp requires IDEA_MCP_DATA_DIR outside the dev repo:',
      );
    }
  });

  it('accepts data dirs that really are outside the repo, including two-dot names and outward symlinks', () => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'idea-mcp-outside-')));
    tempDirs.push(outside);
    mkdirSync(join(outside, 'elsewhere'));
    symlinkSync(join(outside, 'elsewhere'), join(outside, 'elsewhere-alias'), 'dir');

    expect(resolveIdeaDataDir({ IDEA_MCP_DATA_DIR: join(outside, '..idea-data') })).toBe(join(outside, '..idea-data'));
    expect(resolveIdeaDataDir({ IDEA_MCP_DATA_DIR: join(outside, 'elsewhere-alias', 'idea-data') }))
      .toBe(join(outside, 'elsewhere-alias', 'idea-data'));
  });

  it('judges a stand-in repo root under both readings: as spelled and where the path really lands', () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'idea-mcp-standin-repo-')));
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'idea-mcp-standin-outside-')));
    tempDirs.push(repo, outside);
    // Spelled inside through a two-dot name that is a symlink leading out of the repo.
    symlinkSync(outside, join(repo, '..linked'), 'dir');
    // Spelled outside through an alias that leads into the repo.
    symlinkSync(repo, join(outside, 'repo-alias'), 'dir');

    expect(isWithinRepoRoot(join(repo, '..linked', 'idea-data'), repo)).toBe(true);
    expect(isWithinRepoRoot(join(outside, 'repo-alias', 'idea-data'), repo)).toBe(true);
    expect(isWithinRepoRoot(join(outside, '..idea-data'), repo)).toBe(false);
    expect(isWithinRepoRoot(join(repo, '..', 'sibling', 'idea-data'), repo)).toBe(false);
  });

  it('refuses a data dir whose real location cannot be determined (dangling symlink)', () => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'idea-mcp-dangling-')));
    tempDirs.push(outside);
    symlinkSync(join(outside, 'missing-target'), join(outside, 'dangling'), 'dir');

    expect(() => resolveIdeaDataDir({ IDEA_MCP_DATA_DIR: join(outside, 'dangling', 'idea-data') })).toThrow(
      /cannot determine where .* lands/,
    );
  });

  it.skipIf(!CASE_FOLDING_REPO_SPELLING)('rejects another letter-case spelling of the repo on a case-insensitive filesystem', () => {
    expect(() => resolveIdeaDataDir({ IDEA_MCP_DATA_DIR: join(CASE_FOLDING_REPO_SPELLING!, 'idea-data') })).toThrow(
      'idea-mcp requires IDEA_MCP_DATA_DIR outside the dev repo:',
    );
  });

  it('fails closed when legacy backend envs are present', () => {
    expect(() => assertNoLegacyIdeaEnv({ IDEA_MCP_BACKEND: 'idea-engine' })).toThrow(
      'idea-mcp no longer supports legacy backend envs: IDEA_MCP_BACKEND; TS idea-engine is the only host authority',
    );
    expect(() => createIdeaRpcClient({ IDEA_MCP_BACKEND: 'idea-engine' })).toThrow(
      'idea-mcp no longer supports legacy backend envs: IDEA_MCP_BACKEND; TS idea-engine is the only host authority',
    );
  });

  it('wires createIdeaRpcClient through the configured data dir', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-mcp-server-'));
    tempDirs.push(rootDir);
    const client = createIdeaRpcClient({ IDEA_MCP_DATA_DIR: rootDir });

    try {
      const initResult = await client.call('campaign.init', initParams('server-entrypoint')) as Record<string, unknown>;
      expect(typeof initResult.campaign_id).toBe('string');
      expect(initResult.status).toBe('running');
    } finally {
      client.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B-10 regression — parseAndCleanToolArgs strips `_confirm` before forwarding
// to the RPC backend. Schema-level tests (rejecting missing/wrong _confirm)
// live in tool-registry.test.ts; this suite locks the server-layer behavior
// that the marker field is never observed by `rpc.call(...)`.
// ─────────────────────────────────────────────────────────────────────────────
describe('B-10 regression — parseAndCleanToolArgs strips _confirm', () => {
  const VALID_CAMPAIGN_ID = 'c4mp41gn';

  it('destructive tool (idea_campaign_complete) with _confirm=true returns args WITHOUT _confirm', () => {
    const cleaned = parseAndCleanToolArgs(getTool('idea_campaign_complete'), {
      campaign_id: VALID_CAMPAIGN_ID,
      idempotency_key: 'complete-test',
      _confirm: true,
    });
    expect(cleaned).toEqual({
      campaign_id: VALID_CAMPAIGN_ID,
      idempotency_key: 'complete-test',
    });
    expect('_confirm' in cleaned).toBe(false);
  });

  it('destructive tool throws on missing _confirm (gate enforced via schema)', () => {
    expect(() => parseAndCleanToolArgs(getTool('idea_campaign_complete'), {
      campaign_id: VALID_CAMPAIGN_ID,
      idempotency_key: 'complete-test',
    })).toThrow();
  });

  it('destructive tool throws on _confirm: false', () => {
    expect(() => parseAndCleanToolArgs(getTool('idea_campaign_complete'), {
      campaign_id: VALID_CAMPAIGN_ID,
      idempotency_key: 'complete-test',
      _confirm: false,
    })).toThrow();
  });

  it('non-destructive tool (idea_campaign_pause) accepts normal args without _confirm', () => {
    const cleaned = parseAndCleanToolArgs(getTool('idea_campaign_pause'), {
      campaign_id: VALID_CAMPAIGN_ID,
      idempotency_key: 'pause-test',
    });
    expect(cleaned).toEqual({
      campaign_id: VALID_CAMPAIGN_ID,
      idempotency_key: 'pause-test',
    });
  });

  it('non-destructive tool REJECTS surplus _confirm field (strict-unknown contract)', () => {
    // Defense-in-depth: a client passing _confirm to a non-destructive
    // tool is making a contract error — surface it loudly rather than
    // silently strip and proceed.
    expect(() => parseAndCleanToolArgs(getTool('idea_campaign_pause'), {
      campaign_id: VALID_CAMPAIGN_ID,
      idempotency_key: 'pause-test',
      _confirm: true,
    })).toThrow();
  });

  it('read-only tool (idea_campaign_status) accepts query args; rejects _confirm', () => {
    expect(parseAndCleanToolArgs(getTool('idea_campaign_status'), {
      campaign_id: VALID_CAMPAIGN_ID,
    })).toEqual({ campaign_id: VALID_CAMPAIGN_ID });

    expect(() => parseAndCleanToolArgs(getTool('idea_campaign_status'), {
      campaign_id: VALID_CAMPAIGN_ID,
      _confirm: true,
    })).toThrow();
  });
});
