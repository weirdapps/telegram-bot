import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnabledPlugins } from '../bridge/src/pluginLoader.js';

interface InstalledRecordSpec {
  /** Relative to <home>/plugins/cache, e.g. 'mp1/foo/1.0.0'. */
  installSubpath: string;
  scope?: string;
}

interface HomeSpec {
  enabled: Record<string, boolean>;
  installed: Record<string, InstalledRecordSpec[]>;
  /** Directories to actually mkdir under <home>/plugins/cache. */
  realDirs: string[];
  omitInstalledManifest?: boolean;
  invalidInstalledManifest?: boolean;
}

function buildClaudeHome(spec: HomeSpec): string {
  const home = mkdtempSync(join(tmpdir(), 'pluginLoader-'));
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ enabledPlugins: spec.enabled }),
  );
  mkdirSync(join(home, 'plugins'), { recursive: true });
  if (!spec.omitInstalledManifest) {
    if (spec.invalidInstalledManifest) {
      writeFileSync(join(home, 'plugins', 'installed_plugins.json'), '{not json');
    } else {
      const plugins: Record<string, { installPath: string; scope?: string }[]> = {};
      for (const [key, records] of Object.entries(spec.installed)) {
        plugins[key] = records.map((r) => ({
          installPath: join(home, 'plugins', 'cache', r.installSubpath),
          ...(r.scope !== undefined ? { scope: r.scope } : {}),
        }));
      }
      writeFileSync(
        join(home, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins }),
      );
    }
  }
  for (const rel of spec.realDirs) {
    mkdirSync(join(home, 'plugins', 'cache', rel), { recursive: true });
  }
  return home;
}

describe('loadEnabledPlugins', () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it('returns empty when settings.json missing', () => {
    home = mkdtempSync(join(tmpdir(), 'pluginLoader-empty-'));
    const out = loadEnabledPlugins({ claudeHome: home });
    expect(out.plugins).toEqual([]);
    expect(out.skipped).toEqual([]);
  });

  it('loads enabled plugins by installPath from installed_plugins.json', () => {
    home = buildClaudeHome({
      enabled: { 'foo@mp1': true, 'bar@mp1': true },
      installed: {
        'foo@mp1': [{ installSubpath: 'mp1/foo/1.0.0', scope: 'user' }],
        'bar@mp1': [{ installSubpath: 'mp1/bar/2.0.0', scope: 'user' }],
      },
      realDirs: ['mp1/foo/1.0.0', 'mp1/bar/2.0.0'],
    });
    const out = loadEnabledPlugins({ claudeHome: home });
    expect(out.plugins).toHaveLength(2);
    expect(out.plugins[0]).toEqual({
      type: 'local',
      path: join(home, 'plugins/cache/mp1/foo/1.0.0'),
    });
    expect(out.loadedKeys).toEqual(['foo@mp1', 'bar@mp1']);
    expect(out.skipped).toEqual([]);
  });

  it('skips plugins disabled (value=false) in settings', () => {
    home = buildClaudeHome({
      enabled: { 'foo@mp1': true, 'bar@mp1': false },
      installed: {
        'foo@mp1': [{ installSubpath: 'mp1/foo/1.0.0', scope: 'user' }],
        'bar@mp1': [{ installSubpath: 'mp1/bar/2.0.0', scope: 'user' }],
      },
      realDirs: ['mp1/foo/1.0.0', 'mp1/bar/2.0.0'],
    });
    const out = loadEnabledPlugins({ claudeHome: home });
    expect(out.loadedKeys).toEqual(['foo@mp1']);
  });

  it('skips entry when installer manifest has no record for the key', () => {
    home = buildClaudeHome({
      enabled: { 'ghost@mp1': true },
      installed: {},
      realDirs: [],
    });
    const out = loadEnabledPlugins({ claudeHome: home });
    expect(out.plugins).toEqual([]);
    expect(out.skipped).toEqual([{ key: 'ghost@mp1', reason: 'not in installer manifest' }]);
  });

  it('skips entry when installPath does not exist on disk', () => {
    home = buildClaudeHome({
      enabled: { 'foo@mp1': true },
      installed: {
        'foo@mp1': [{ installSubpath: 'mp1/foo/1.0.0', scope: 'user' }],
      },
      realDirs: [], // no actual dir
    });
    const out = loadEnabledPlugins({ claudeHome: home });
    expect(out.plugins).toEqual([]);
    expect(out.skipped[0]?.reason).toMatch(/installPath missing on disk/);
  });

  it('treats every enabled key as skipped when installer manifest is missing', () => {
    home = buildClaudeHome({
      enabled: { 'foo@mp1': true, 'bar@mp1': true },
      installed: {},
      realDirs: [],
      omitInstalledManifest: true,
    });
    const out = loadEnabledPlugins({ claudeHome: home });
    expect(out.plugins).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual([
      'no installer manifest',
      'no installer manifest',
    ]);
  });

  it('treats every enabled key as skipped when installer manifest is invalid JSON', () => {
    home = buildClaudeHome({
      enabled: { 'foo@mp1': true },
      installed: {},
      realDirs: [],
      invalidInstalledManifest: true,
    });
    const out = loadEnabledPlugins({ claudeHome: home });
    expect(out.plugins).toEqual([]);
    expect(out.skipped[0]?.reason).toBe('no installer manifest');
  });

  it('honours BRIDGE_PLUGIN_DENYLIST via opts', () => {
    home = buildClaudeHome({
      enabled: { 'foo@mp1': true, 'bar@mp1': true },
      installed: {
        'foo@mp1': [{ installSubpath: 'mp1/foo/1.0.0', scope: 'user' }],
        'bar@mp1': [{ installSubpath: 'mp1/bar/2.0.0', scope: 'user' }],
      },
      realDirs: ['mp1/foo/1.0.0', 'mp1/bar/2.0.0'],
    });
    const out = loadEnabledPlugins({ claudeHome: home, denylist: 'bar@mp1' });
    expect(out.loadedKeys).toEqual(['foo@mp1']);
    expect(out.denied).toEqual(['bar@mp1']);
  });

  it('parses comma-separated denylist with whitespace', () => {
    home = buildClaudeHome({
      enabled: { 'a@m': true, 'b@m': true, 'c@m': true },
      installed: {
        'a@m': [{ installSubpath: 'm/a/1', scope: 'user' }],
        'b@m': [{ installSubpath: 'm/b/1', scope: 'user' }],
        'c@m': [{ installSubpath: 'm/c/1', scope: 'user' }],
      },
      realDirs: ['m/a/1', 'm/b/1', 'm/c/1'],
    });
    const out = loadEnabledPlugins({ claudeHome: home, denylist: 'a@m , c@m' });
    expect(out.loadedKeys).toEqual(['b@m']);
    expect(out.denied.sort()).toEqual(['a@m', 'c@m']);
  });

  it('prefers user-scoped record when multiple scopes exist', () => {
    home = buildClaudeHome({
      enabled: { 'foo@mp1': true },
      installed: {
        'foo@mp1': [
          { installSubpath: 'mp1/foo/project', scope: 'project' },
          { installSubpath: 'mp1/foo/user', scope: 'user' },
        ],
      },
      realDirs: ['mp1/foo/user', 'mp1/foo/project'],
    });
    const out = loadEnabledPlugins({ claudeHome: home });
    expect(out.plugins[0]?.path).toBe(join(home, 'plugins/cache/mp1/foo/user'));
  });

  // ── BRIDGE_PLUGIN_ALLOWLIST (plan-004) ─────────────────────────────────
  // Allowlist is the inverse of the existing denylist: when set it RESTRICTS
  // the load to a curated subset. When unset (default) the loader behaves
  // exactly as before — every enabled plugin is loaded.

  it('loads every enabled plugin when allowlist is undefined (legacy behaviour preserved)', () => {
    home = buildClaudeHome({
      enabled: { 'a@m': true, 'b@m': true, 'c@m': true },
      installed: {
        'a@m': [{ installSubpath: 'm/a/1', scope: 'user' }],
        'b@m': [{ installSubpath: 'm/b/1', scope: 'user' }],
        'c@m': [{ installSubpath: 'm/c/1', scope: 'user' }],
      },
      realDirs: ['m/a/1', 'm/b/1', 'm/c/1'],
    });
    const out = loadEnabledPlugins({ claudeHome: home });
    expect(out.loadedKeys.sort()).toEqual(['a@m', 'b@m', 'c@m']);
  });

  it('loads only allowlisted plugins when allowlist is set', () => {
    home = buildClaudeHome({
      enabled: { 'a@m': true, 'b@m': true, 'c@m': true },
      installed: {
        'a@m': [{ installSubpath: 'm/a/1', scope: 'user' }],
        'b@m': [{ installSubpath: 'm/b/1', scope: 'user' }],
        'c@m': [{ installSubpath: 'm/c/1', scope: 'user' }],
      },
      realDirs: ['m/a/1', 'm/b/1', 'm/c/1'],
    });
    const out = loadEnabledPlugins({ claudeHome: home, allowlist: 'a@m,c@m' });
    expect(out.loadedKeys.sort()).toEqual(['a@m', 'c@m']);
    const skippedKeys = out.skipped.map((s) => s.key);
    expect(skippedKeys).toContain('b@m');
    expect(out.skipped.find((s) => s.key === 'b@m')?.reason).toMatch(/not in allowlist/);
  });

  it('parses comma-separated allowlist with whitespace', () => {
    home = buildClaudeHome({
      enabled: { 'a@m': true, 'b@m': true, 'c@m': true },
      installed: {
        'a@m': [{ installSubpath: 'm/a/1', scope: 'user' }],
        'b@m': [{ installSubpath: 'm/b/1', scope: 'user' }],
        'c@m': [{ installSubpath: 'm/c/1', scope: 'user' }],
      },
      realDirs: ['m/a/1', 'm/b/1', 'm/c/1'],
    });
    const out = loadEnabledPlugins({ claudeHome: home, allowlist: ' a@m , c@m ' });
    expect(out.loadedKeys.sort()).toEqual(['a@m', 'c@m']);
  });

  it('treats empty allowlist string as undefined (loads all enabled)', () => {
    home = buildClaudeHome({
      enabled: { 'a@m': true, 'b@m': true },
      installed: {
        'a@m': [{ installSubpath: 'm/a/1', scope: 'user' }],
        'b@m': [{ installSubpath: 'm/b/1', scope: 'user' }],
      },
      realDirs: ['m/a/1', 'm/b/1'],
    });
    const out = loadEnabledPlugins({ claudeHome: home, allowlist: '' });
    expect(out.loadedKeys.sort()).toEqual(['a@m', 'b@m']);
  });

  it('allowlist applies BEFORE denylist (denied entries still listed in denied)', () => {
    home = buildClaudeHome({
      enabled: { 'a@m': true, 'b@m': true, 'c@m': true },
      installed: {
        'a@m': [{ installSubpath: 'm/a/1', scope: 'user' }],
        'b@m': [{ installSubpath: 'm/b/1', scope: 'user' }],
        'c@m': [{ installSubpath: 'm/c/1', scope: 'user' }],
      },
      realDirs: ['m/a/1', 'm/b/1', 'm/c/1'],
    });
    const out = loadEnabledPlugins({
      claudeHome: home,
      allowlist: 'a@m,b@m',
      denylist: 'b@m',
    });
    expect(out.loadedKeys).toEqual(['a@m']);
    expect(out.denied).toEqual(['b@m']);
    expect(out.skipped.find((s) => s.key === 'c@m')?.reason).toMatch(/not in allowlist/);
  });
});
