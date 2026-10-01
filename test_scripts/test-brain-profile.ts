import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRAIN_ALLOWED_TOOLS,
  BrainProfileError,
  buildBrainOptions,
  isBrainProfile,
  loadBrainProfile,
  type BrainProfile,
} from '../bridge/src/brain/profile.js';
import { fallbackTier } from '../bridge/src/claudeFallback.js';

let dir: string;

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    TELEGRAM_BRIDGE_STATE_PATH: join(dir, 'subjects.json'),
    TELEGRAM_BRIDGE_SYSTEM_PROMPT_FILE: join(dir, 'persona.md'),
    BRIDGE_BRAIN_MCP_URL: 'http://127.0.0.1:8765/mcp',
    BRAIN_MCP_TOKEN_FILE: join(dir, 'token'),
    BRIDGE_NEWS_MCP_COMMAND: '/opt/news/run_mcp.sh',
    ANTHROPIC_MODEL: 'model-primary',
    ...over,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'brain-profile-'));
  await fs.writeFile(join(dir, 'token'), 'a'.repeat(64) + '\n');
  await fs.writeFile(join(dir, 'persona.md'), 'The owner is a test persona.\n');
  await fs.writeFile(join(dir, 'base.md'), 'Base rules.\n');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('isBrainProfile', () => {
  it('is true only for TELEGRAM_BRIDGE_PROFILE=brain', () => {
    expect(isBrainProfile({ TELEGRAM_BRIDGE_PROFILE: 'brain' })).toBe(true);
    expect(isBrainProfile({ TELEGRAM_BRIDGE_PROFILE: 'general' })).toBe(false);
    expect(isBrainProfile({})).toBe(false);
  });
});

describe('loadBrainProfile', () => {
  it('reads the profile and joins the base prompt and the persona, in that order', () => {
    const p = loadBrainProfile(env(), join(dir, 'base.md'));
    expect(p.brainMcpToken).toBe('a'.repeat(64));
    expect(p.systemPrompt).toBe('Base rules.\n\nThe owner is a test persona.');
    expect(p.cwd).toBe(join(dir, 'claude'));
    expect(p.model).toBe('model-primary');
  });

  it.each([
    'CLAUDE_CONFIG_DIR',
    'TELEGRAM_BRIDGE_STATE_PATH',
    'TELEGRAM_BRIDGE_SYSTEM_PROMPT_FILE',
    'BRIDGE_BRAIN_MCP_URL',
    'BRAIN_MCP_TOKEN_FILE',
    'BRIDGE_NEWS_MCP_COMMAND',
  ])('names %s when it is missing', (variable) => {
    let caught: unknown;
    try {
      loadBrainProfile(env({ [variable]: undefined }), join(dir, 'base.md'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrainProfileError);
    expect((caught as BrainProfileError).variable).toBe(variable);
  });

  it('refuses an unreadable token file and an empty persona', async () => {
    expect(() =>
      loadBrainProfile(env({ BRAIN_MCP_TOKEN_FILE: join(dir, 'absent') }), join(dir, 'base.md')),
    ).toThrow(BrainProfileError);
    await fs.writeFile(join(dir, 'persona.md'), '   \n');
    expect(() => loadBrainProfile(env(), join(dir, 'base.md'))).toThrow(/empty/);
  });

  it('takes the cwd from TELEGRAM_BRIDGE_CWD and labels an unset ANTHROPIC_MODEL', () => {
    const p = loadBrainProfile(
      env({ TELEGRAM_BRIDGE_CWD: join(dir, 'work'), ANTHROPIC_MODEL: undefined }),
      join(dir, 'base.md'),
    );
    expect(p.cwd).toBe(join(dir, 'work'));
    expect(p.model).toBe('(SDK default)');
  });
});

describe('buildBrainOptions', () => {
  const profile: BrainProfile = {
    statePath: '/s/subjects.json',
    brainMcpUrl: 'http://127.0.0.1:8765/mcp',
    brainMcpToken: 'tok',
    newsMcpCommand: '/opt/news/run_mcp.sh',
    systemPrompt: 'prompt',
    cwd: '/c',
    model: 'model-primary',
  };

  it('loads only the allowlisted tools and never bypasses permissions', () => {
    const o = buildBrainOptions(profile, {}, new AbortController(), {});
    expect(o.tools).toEqual(['WebSearch']);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.strictMcpConfig).toBe(true);
    expect(o.plugins).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.allowedTools).toEqual([...BRAIN_ALLOWED_TOOLS]);
    expect(o.maxTurns).toBe(25);
    expect(o.includePartialMessages).toBe(true);
    expect(o.systemPrompt).toBe('prompt');
    expect(o.settings).toEqual({ promptCacheTtl: '1h', cleanupPeriodDays: 30 });
    // Exactly these keys, so agents, extraArgs, canUseTool, disallowedTools or a
    // permission override cannot be added unseen.
    expect(Object.keys(o).sort()).toEqual([
      'abortController',
      'allowedTools',
      'cwd',
      'env',
      'includePartialMessages',
      'maxTurns',
      'mcpServers',
      'permissionMode',
      'plugins',
      'settingSources',
      'settings',
      'strictMcpConfig',
      'systemPrompt',
      'tools',
    ]);
  });

  it('allowlists 27 brain tools, 4 news tools and web search, and nothing that writes or fetches', () => {
    expect(BRAIN_ALLOWED_TOOLS).toHaveLength(32);
    expect(BRAIN_ALLOWED_TOOLS.filter((t) => t.startsWith('mcp__second-brain__'))).toHaveLength(27);
    expect(BRAIN_ALLOWED_TOOLS).toContain('mcp__second-brain__sql_query');
    expect(BRAIN_ALLOWED_TOOLS).toContain('mcp__news-reader__search_news');
    for (const t of ['Bash', 'WebFetch', 'Write', 'Edit', 'Read', 'Task']) {
      expect(BRAIN_ALLOWED_TOOLS).not.toContain(t);
    }
  });

  it('reaches the brain over HTTP with the bearer token kept off the command line, and news over stdio', () => {
    const token = 'brain-token-0123456789';
    const o = buildBrainOptions({ ...profile, brainMcpToken: token }, {}, new AbortController(), {
      BRAIN_MCP_TOKEN: 'inherited',
    });
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['second-brain', 'news-reader']);
    // The SDK passes mcpServers to the CLI as --mcp-config on its command line, and
    // argv is world-readable; the child env is owner-only, so the token travels there
    // and the CLI expands the placeholder when it connects.
    expect(o.mcpServers?.['second-brain']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8765/mcp',
      headers: { Authorization: 'Bearer ${BRAIN_MCP_TOKEN}' },
      alwaysLoad: true,
      timeout: 90_000,
    });
    expect(o.env?.BRAIN_MCP_TOKEN).toBe(token);
    expect(JSON.stringify(o.mcpServers)).not.toContain(token);
    expect(o.mcpServers?.['news-reader']).toEqual({
      type: 'stdio',
      command: '/opt/news/run_mcp.sh',
      args: [],
    });
  });

  it('maps the plan to resume, sessionId, model and region', () => {
    const resumed = buildBrainOptions(profile, { resume: 's1' }, new AbortController(), {});
    expect(resumed.resume).toBe('s1');
    expect(resumed.sessionId).toBeUndefined();
    const fresh = buildBrainOptions(
      profile,
      { sessionId: 'n1', model: 'fb', region: 'europe-west1' },
      new AbortController(),
      { CLOUD_ML_REGION: 'eu', KEEP: 'x' },
    );
    expect(fresh.sessionId).toBe('n1');
    expect(fresh.model).toBe('fb');
    expect(fresh.env).toEqual({
      CLOUD_ML_REGION: 'europe-west1',
      KEEP: 'x',
      BRAIN_MCP_TOKEN: 'tok',
    });
  });

  it('swaps the region in a copy, never in the env it was given', () => {
    const e: NodeJS.ProcessEnv = { CLOUD_ML_REGION: 'eu' };
    const o = buildBrainOptions(profile, { region: 'europe-west1' }, new AbortController(), e);
    expect(o.env?.CLOUD_ML_REGION).toBe('europe-west1');
    expect(o.env).not.toBe(e);
    expect(e).toStrictEqual({ CLOUD_ML_REGION: 'eu' });
  });

  it('passes the cwd and the abort controller through, and keeps the region and model the env sets', () => {
    const abort = new AbortController();
    const o = buildBrainOptions(profile, { resume: 's1' }, abort, {
      CLOUD_ML_REGION: 'eu',
      ANTHROPIC_MODEL: 'm',
    });
    expect(o.cwd).toBe('/c');
    expect(o.abortController).toBe(abort);
    expect(o.env).toEqual({ CLOUD_ML_REGION: 'eu', ANTHROPIC_MODEL: 'm', BRAIN_MCP_TOKEN: 'tok' });
    expect(o.model).toBeUndefined();
  });
});

describe('fallbackTier', () => {
  it('defaults to the general bridge fallback and follows the env', () => {
    expect(fallbackTier({})).toEqual({ model: 'claude-opus-4-6[1m]', region: 'europe-west1' });
    expect(fallbackTier({ VERTEX_MODEL_FALLBACK: 'm', VERTEX_REGION_FALLBACK: 'r' })).toEqual({
      model: 'm',
      region: 'r',
    });
  });
});
