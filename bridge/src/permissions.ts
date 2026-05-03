import type { CanUseTool, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

/**
 * ====================================================================
 * USER-EDITABLE — bridge permission policy
 * ====================================================================
 *
 * Two strategies:
 *
 *   'bypassPermissions' (default)
 *     Mirrors your interactive ~/nbg_claude.sh setup. Every tool call
 *     fires without gating. Maximum power. Risk: a prompt-injection
 *     reaching Claude (e.g. adversarial content in an email Claude
 *     reads) could trigger anything reachable through your MCP servers
 *     — including writes, sends, and trades. canUseTool() below is
 *     IGNORED in this mode.
 *
 *   'default'
 *     canUseTool() decides per call. Maintained allowlist; anything
 *     unknown is denied. Safer; more upkeep.
 *
 * To switch: change the return value of getPermissionMode() below.
 * The 5-10 lines worth tweaking are inside canUseTool(): adjust the
 * ALLOW / DENY sets to match your threat model.
 */
export function getPermissionMode(): PermissionMode {
  return 'bypassPermissions';
}

/** Only consulted when getPermissionMode() returns 'default'. */
export const canUseTool: CanUseTool = async (toolName, input) => {
  // Read-only / low-blast-radius tools — auto-allow.
  const ALLOW = new Set<string>([
    'Read',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
    // Add MCP read-only tools you trust here, e.g.:
    // 'mcp__second-brain__search_emails',
    // 'mcp__outlook-bridge__outlook_list_calendar',
  ]);

  // Money-moving / outbound-comms / mutating tools — hard deny.
  const DENY = new Set<string>([
    // 'mcp__etoro-trading__open_position',
    // 'mcp__etoro-trading__close_position',
    // 'mcp__email-handler__send_mail',
  ]);

  if (ALLOW.has(toolName)) return { behavior: 'allow', updatedInput: input };
  if (DENY.has(toolName)) {
    return {
      behavior: 'deny',
      message: `${toolName} is blocked from the Telegram bridge.`,
      interrupt: false,
    };
  }
  // Default-deny posture: anything not explicitly allowed is rejected.
  return {
    behavior: 'deny',
    message: `${toolName} is not in the bridge allowlist.`,
    interrupt: false,
  };
};
