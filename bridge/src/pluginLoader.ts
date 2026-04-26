import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../../src/logger/logger.js';

/**
 * Load the user's enabled Claude Code plugins for use by the Agent SDK.
 *
 * Strategy (option B from plan-003):
 *   1. Read ~/.claude/settings.json::enabledPlugins → set of "name@marketplace"
 *      keys whose value is `true`.
 *   2. Read ~/.claude/plugins/installed_plugins.json — the installer's source
 *      of truth — and pick each enabled key's `installPath` directly. This
 *      avoids version-resolution heuristics (semver vs commit-hash dirs) and
 *      side-steps stray `temp_git_*` cache entries.
 *   3. Apply BRIDGE_PLUGIN_DENYLIST (comma-separated `name@marketplace`).
 *   4. Skip + warn entries whose installer record or path is missing.
 *
 * Pure I/O helpers below are split out so they can be unit-tested with a
 * fixture cache directory by overriding `claudeHome`.
 */

export interface LoadResult {
  plugins: SdkPluginConfig[];
  loadedKeys: string[];
  skipped: { key: string; reason: string }[];
  denied: string[];
}

interface InstalledRecord {
  scope?: string;
  installPath: string;
  version?: string;
}

interface InstalledManifest {
  version?: number;
  plugins?: Record<string, InstalledRecord[]>;
}

interface SettingsFile {
  enabledPlugins?: Record<string, boolean>;
}

export interface LoadOptions {
  /** Override $HOME/.claude root — used by tests. */
  claudeHome?: string;
  /** Comma-separated `name@marketplace` to skip. Defaults to env var. */
  denylist?: string;
  /**
   * Comma-separated `name@marketplace` to RESTRICT loading to (plan-004).
   * When set, only enabled plugins that also appear here are loaded; the
   * rest are added to `skipped` with reason `not in allowlist`. When unset
   * or empty, behaviour is unchanged (every enabled plugin is loaded).
   * Allowlist is evaluated BEFORE denylist.
   */
  allowlist?: string;
  logger?: Logger;
}

export function loadEnabledPlugins(opts: LoadOptions = {}): LoadResult {
  const home = opts.claudeHome ?? join(homedir(), '.claude');
  const denySet = parseCommaSet(opts.denylist ?? process.env.BRIDGE_PLUGIN_DENYLIST);
  const allowSet = parseCommaSet(opts.allowlist ?? process.env.BRIDGE_PLUGIN_ALLOWLIST);
  const log = opts.logger;

  const result: LoadResult = { plugins: [], loadedKeys: [], skipped: [], denied: [] };

  const enabled = readEnabledPlugins(join(home, 'settings.json'));
  if (enabled.length === 0) {
    log?.warn(
      { component: 'pluginLoader', settingsPath: join(home, 'settings.json') },
      'no enabled plugins found in settings.json — bridge will run with SDK defaults only',
    );
    return result;
  }

  const installed = readInstalledManifest(join(home, 'plugins', 'installed_plugins.json'));
  if (installed === null) {
    log?.error(
      { component: 'pluginLoader', enabledCount: enabled.length },
      'installed_plugins.json missing or invalid — cannot resolve plugin paths; loading zero plugins',
    );
    for (const key of enabled) result.skipped.push({ key, reason: 'no installer manifest' });
    return result;
  }

  for (const key of enabled) {
    // Allowlist (plan-004) is evaluated FIRST: if set, anything not in it is
    // skipped before we check the denylist. An entry in both lists ends up in
    // `denied` (denylist still wins for the explicitly-denied subset).
    if (allowSet.size > 0 && !allowSet.has(key)) {
      result.skipped.push({ key, reason: 'not in allowlist' });
      continue;
    }
    if (denySet.has(key)) {
      result.denied.push(key);
      continue;
    }
    const records = installed.plugins?.[key];
    if (!records || records.length === 0) {
      result.skipped.push({ key, reason: 'not in installer manifest' });
      continue;
    }
    // Plan-003 + option-B: there is at most one record per key today
    // (verified empirically at install time). If multiple ever appear (user +
    // project scopes), prefer the user-scoped one — that matches what the
    // CLI shows in /plugins.
    const chosen = records.find((r) => r.scope === 'user') ?? records[0];
    if (!chosen) {
      result.skipped.push({ key, reason: 'installer record empty' });
      continue;
    }
    if (!isReadableDir(chosen.installPath)) {
      result.skipped.push({ key, reason: `installPath missing on disk: ${chosen.installPath}` });
      continue;
    }
    result.plugins.push({ type: 'local', path: chosen.installPath });
    result.loadedKeys.push(key);
  }

  if (log) {
    if (result.skipped.length > 0) {
      log.warn(
        { component: 'pluginLoader', skipped: result.skipped },
        `skipped ${result.skipped.length} plugin(s) — see entries`,
      );
    }
    if (result.denied.length > 0) {
      log.info(
        { component: 'pluginLoader', denied: result.denied },
        `denied ${result.denied.length} plugin(s) via BRIDGE_PLUGIN_DENYLIST`,
      );
    }
  }
  return result;
}

function readEnabledPlugins(settingsPath: string): string[] {
  if (!existsSync(settingsPath)) return [];
  let parsed: SettingsFile;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as SettingsFile;
  } catch {
    return [];
  }
  const map = parsed.enabledPlugins ?? {};
  return Object.entries(map)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}

function readInstalledManifest(manifestPath: string): InstalledManifest | null {
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as InstalledManifest;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isReadableDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function parseCommaSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}
