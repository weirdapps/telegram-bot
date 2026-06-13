import { execFileSync } from 'node:child_process';

const MCP_PROCESS_PATTERNS = ['mongodb-mcp-server', 'mcp-server-', '@modelcontextprotocol/'];

function pgrepLines(args: string[]): string[] {
  try {
    return execFileSync('pgrep', args, { encoding: 'utf8', timeout: 5000 })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Kill orphaned MCP server processes that were spawned by the SDK but
 * survived after the query() stream ended. Scans descendants of the
 * current process for known MCP server binary names.
 *
 * Safe to call frequently — no-op when nothing matches.
 */
export function reapOrphanedMcpProcesses(log?: {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}): number {
  let killed = 0;

  const directChildren = pgrepLines(['-P', String(process.pid)]);
  const searchPids = [String(process.pid), ...directChildren];

  for (const ppid of searchPids) {
    const lines = pgrepLines(['-la', '-P', ppid]);
    for (const line of lines) {
      if (!MCP_PROCESS_PATTERNS.some((p) => line.includes(p))) continue;
      const pid = parseInt(line.split(/\s+/)[0], 10);
      if (isNaN(pid) || pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGTERM');
        killed++;
      } catch {
        /* already dead */
      }
    }
  }

  if (killed > 0) {
    log?.warn({ component: 'mcpReaper', killed }, `reaped ${killed} orphaned MCP process(es)`);
  }
  return killed;
}

/**
 * Broader sweep: kill ALL user-owned processes matching MCP patterns.
 * Use only at shutdown when we know nothing else should be running them.
 */
export function reapAllMcpProcesses(log?: {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}): number {
  let killed = 0;
  for (const pattern of MCP_PROCESS_PATTERNS) {
    const pids = pgrepLines(['-f', pattern])
      .map((s) => parseInt(s, 10))
      .filter((p) => !isNaN(p) && p !== process.pid);

    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        killed++;
      } catch {
        /* already dead */
      }
    }
  }
  if (killed > 0) {
    log?.warn(
      { component: 'mcpReaper', killed },
      `shutdown sweep: killed ${killed} MCP process(es)`,
    );
  }
  return killed;
}
