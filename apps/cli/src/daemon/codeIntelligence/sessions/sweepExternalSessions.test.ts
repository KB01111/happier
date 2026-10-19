import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { claudeDirectSessionProviderOps } from '@/backends/claude/directSessions/providerOps';

import { observeCheckout } from '../commits/observeCheckout';
import { openCodeIntelligenceStore, type CodeIntelligenceStore } from '../store/codeIntelligenceStore';
import { deriveObservedSessionStatus, sweepExternalSessions } from './sweepExternalSessions';

const execFile = promisify(execFileCallback);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SESSION_ID = '0f3c6f2e-6a59-4d1e-9b7a-1d2c3e4f5a6b';

async function setup(): Promise<Readonly<{ repo: string; sessionFile: string; configDir: string; store: CodeIntelligenceStore }>> {
  const root = await mkdtemp(join(tmpdir(), 'ci-sessions-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'shop');
  await execFile('git', ['init', '-b', 'main', repo]);
  await execFile('git', ['-C', repo, '-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--allow-empty', '-m', 'initial']);

  // A Claude Code session started outside Happier, in Claude's own on-disk store.
  const configDir = join(root, 'claude-config');
  const projectDir = join(configDir, 'projects', '-tmp-shop');
  await mkdir(projectDir, { recursive: true });
  const sessionFile = join(projectDir, `${SESSION_ID}.jsonl`);
  await writeFile(sessionFile, `${JSON.stringify({
    type: 'user',
    sessionId: SESSION_ID,
    cwd: repo,
    message: { role: 'user', content: 'Fix the cart totals' },
    timestamp: new Date().toISOString(),
  })}\n`);

  const store = openCodeIntelligenceStore({ dbPath: join(root, 'ci.sqlite') });
  cleanups.push(() => store.close());
  return { repo, sessionFile, configDir, store };
}

function sweep(store: CodeIntelligenceStore, configDir: string, processes: Array<{ name: string; cmd?: string }>) {
  return sweepExternalSessions({
    store,
    providers: [{ providerId: 'claude', source: { kind: 'claudeConfig', configDir }, ops: claudeDirectSessionProviderOps }],
    processes,
    nowMs: Date.now(),
    workingDirectoryCache: new Map(),
    observeWorkingDirectory: async (cwd) => (await observeCheckout({
      store,
      cwd,
      registrationSource: 'session',
      excludedPathPrefixes: [],
      resolvePlausibleSessionIds: () => [],
      nowMs: Date.now,
    }))?.checkout ?? null,
  });
}

describe('sweepExternalSessions', () => {
  it('discovers an externally started session read-only and associates it with its repository', async () => {
    const { configDir, store } = await setup();

    const result = await sweep(store, configDir, [{ name: 'claude' }]);

    expect(result.observedSessionIds).toEqual([`claude:${SESSION_ID}`]);
    const [session] = store.listSessions();
    expect(session).toMatchObject({
      providerId: 'claude',
      providerSessionId: SESSION_ID,
      status: 'running',
      providerProcessObserved: true,
      source: 'external',
    });
    const [repository] = store.listRepositories();
    expect(session?.repositoryId).toBe(repository?.repositoryId);
    expect(session?.worktreePath).toBe(repository?.worktrees[0]?.worktreePath);
    expect(store.listEventsAfter({ afterSeq: 0, limit: 10 }).events.map((event) => event.kind)).toEqual([
      'repository_registered',
      'worktree_observed',
      'session_observed',
    ]);
  });

  it('does not treat an old session file as active, even with a provider process running', async () => {
    const { configDir, sessionFile, store } = await setup();
    await sweep(store, configDir, [{ name: 'claude' }]);

    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(sessionFile, anHourAgo, anHourAgo);
    await sweep(store, configDir, [{ name: 'claude' }]);

    expect(store.listSessions()[0]?.status).toBe('idle');
    const transitions = store.listEventsAfter({ afterSeq: 0, limit: 10 }).events.filter((event) => event.kind === 'session_status_changed');
    expect(transitions.map((event) => [event.data.from, event.data.status])).toEqual([['running', 'idle']]);
  });
});

describe('deriveObservedSessionStatus', () => {
  it('lets process evidence strengthen recent activity but never wake an idle session', () => {
    expect(deriveObservedSessionStatus({ activity: 'active_recently', providerProcessObserved: true }).status).toBe('running');
    expect(deriveObservedSessionStatus({ activity: 'active_recently', providerProcessObserved: false }).status).toBe('active_recently');
    expect(deriveObservedSessionStatus({ activity: 'idle', providerProcessObserved: true }).status).toBe('idle');
  });
});
