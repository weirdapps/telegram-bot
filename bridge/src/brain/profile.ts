// bridge/src/brain/profile.ts
//
// The brain profile: what TELEGRAM_BRIDGE_PROFILE=brain reads from the
// environment, and the Agent SDK options every brain turn runs with. The
// options are the safety boundary: one built-in tool, two MCP servers, an exact
// allowlist, and 'dontAsk', which denies anything not on it.

import { readFileSync } from 'node:fs';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

export const BRAIN_SERVER = 'second-brain';
export const NEWS_SERVER = 'news-reader';

const SECOND_BRAIN_TOOLS = [
  'attachment_image_search',
  'conversation_context',
  'email_thread',
  'meeting_prep',
  'outlook_live_search',
  'person_context',
  'query_actions',
  'query_calendar_events',
  'query_decisions',
  'query_emails',
  'recall',
  'recall_preference',
  'recent_conversations',
  'search_attachments',
  'search_conversations',
  'search_emails',
  'search_teams',
  'search_whatsapp',
  'sender_brief',
  'sharepoint_index',
  'sql_query',
  'sql_schema',
  'stale_threads',
  'stats',
  'teams_chat_summary',
  'teams_thread_context',
  'topic_context',
] as const;

const NEWS_TOOLS = ['digest_history', 'news_stats', 'recent_for_tickers', 'search_news'] as const;

/** Every tool a brain turn may call, by exact name. Anything else is denied. */
export const BRAIN_ALLOWED_TOOLS: readonly string[] = [
  ...SECOND_BRAIN_TOOLS.map((t) => `mcp__${BRAIN_SERVER}__${t}`),
  ...NEWS_TOOLS.map((t) => `mcp__${NEWS_SERVER}__${t}`),
  'WebSearch',
];

export const BASE_PROMPT_PATH = new URL('./prompts/brain-base.md', import.meta.url);

export class BrainProfileError extends Error {
  constructor(
    message: string,
    readonly variable: string,
  ) {
    super(message);
    this.name = 'BrainProfileError';
  }
}

export interface BrainProfile {
  readonly statePath: string;
  readonly brainMcpUrl: string;
  readonly brainMcpToken: string;
  readonly newsMcpCommand: string;
  readonly systemPrompt: string;
  readonly cwd: string;
  readonly model: string;
}

/** How one turn starts: resume a session, or a new one with its own id, optionally on another model. */
export interface TurnPlan {
  readonly resume?: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly region?: string;
}

export function isBrainProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELEGRAM_BRIDGE_PROFILE === 'brain';
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new BrainProfileError(`${name} is required for TELEGRAM_BRIDGE_PROFILE=brain`, name);
  }
  return value;
}

function readNeeded(path: string | URL, variable: string, what: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new BrainProfileError(
      `cannot read ${what} at ${String(path)}: ${err instanceof Error ? err.message : String(err)}`,
      variable,
    );
  }
  if (text === '') throw new BrainProfileError(`${what} at ${String(path)} is empty`, variable);
  return text;
}

export function loadBrainProfile(
  env: NodeJS.ProcessEnv = process.env,
  basePromptPath: string | URL = BASE_PROMPT_PATH,
): BrainProfile {
  // Set for the whole process by the unit, so the SDK subprocess and the SDK's
  // session helpers agree on where transcripts live (spec 4.2).
  const configDir = need(env, 'CLAUDE_CONFIG_DIR');
  const statePath = need(env, 'TELEGRAM_BRIDGE_STATE_PATH');
  const personaFile = need(env, 'TELEGRAM_BRIDGE_SYSTEM_PROMPT_FILE');
  const brainMcpUrl = need(env, 'BRIDGE_BRAIN_MCP_URL');
  const tokenFile = need(env, 'BRAIN_MCP_TOKEN_FILE');
  const newsMcpCommand = need(env, 'BRIDGE_NEWS_MCP_COMMAND');
  const base = readNeeded(basePromptPath, 'BASE_PROMPT_PATH', 'the base prompt');
  const persona = readNeeded(personaFile, 'TELEGRAM_BRIDGE_SYSTEM_PROMPT_FILE', 'the persona file');
  return {
    statePath,
    brainMcpUrl,
    brainMcpToken: readNeeded(tokenFile, 'BRAIN_MCP_TOKEN_FILE', 'the MCP token'),
    newsMcpCommand,
    systemPrompt: `${base}\n\n${persona}`,
    cwd: env.TELEGRAM_BRIDGE_CWD?.trim() || configDir,
    model: env.ANTHROPIC_MODEL?.trim() || '(SDK default)',
  };
}

function childEnv(
  env: NodeJS.ProcessEnv,
  region: string | undefined,
  brainMcpToken: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  if (region !== undefined) out.CLOUD_ML_REGION = region;
  out.BRAIN_MCP_TOKEN = brainMcpToken;
  return out;
}

export function buildBrainOptions(
  p: BrainProfile,
  plan: TurnPlan,
  abortController: AbortController,
  env: NodeJS.ProcessEnv = process.env,
): Options {
  return {
    abortController,
    cwd: p.cwd,
    tools: ['WebSearch'],
    allowedTools: [...BRAIN_ALLOWED_TOOLS],
    permissionMode: 'dontAsk',
    strictMcpConfig: true,
    mcpServers: {
      [BRAIN_SERVER]: {
        type: 'http',
        url: p.brainMcpUrl,
        // A literal placeholder, not a template literal: the SDK passes mcpServers to
        // the CLI as --mcp-config on its command line, and argv is world-readable. The
        // token rides in the child env (owner-only) and the CLI expands it on connect.
        headers: { Authorization: 'Bearer ${BRAIN_MCP_TOKEN}' },
        alwaysLoad: true,
        timeout: 90_000,
      },
      [NEWS_SERVER]: { type: 'stdio', command: p.newsMcpCommand, args: [] },
    },
    plugins: [],
    settingSources: [],
    systemPrompt: p.systemPrompt,
    includePartialMessages: true,
    maxTurns: 25,
    settings: { promptCacheTtl: '1h', cleanupPeriodDays: 30 },
    // Per turn, never by mutating process.env: two subjects can run at once, and
    // only the fallback retry moves to another region.
    env: childEnv(env, plan.region, p.brainMcpToken),
    ...(plan.resume !== undefined ? { resume: plan.resume } : {}),
    ...(plan.sessionId !== undefined ? { sessionId: plan.sessionId } : {}),
    ...(plan.model !== undefined ? { model: plan.model } : {}),
  };
}
