import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeCodeIntelligenceSettings, type CodeIntelligenceSettingsV1 } from '@happier-dev/protocol';

import { startCodeIntelligenceWorker, type CodeIntelligenceWorkerDeps, type CodeIntelligenceWorkerHandle } from './codeIntelligenceWorker';

const execFile = promisify(execFileCallback);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFile('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', ...args], { cwd });
}

async function setupRepo(): Promise<Readonly<{ root: string; repo: string }>> {
  const root = await mkdtemp(join(tmpdir(), 'ci-worker-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'shop');
  await execFile('git', ['init', '-b', 'main', repo]);
  await writeFile(join(repo, 'cart.py'), 'def total(items):\n    return len(items)\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  return { root, repo };
}

function buildDeps(root: string, initial: Partial<CodeIntelligenceSettingsV1>, watched: Map<string, () => void>): CodeIntelligenceWorkerDeps {
  let persisted = normalizeCodeIntelligenceSettings(initial);
  return {
    dbPath: join(root, 'state', 'ci.sqlite'),
    readSettings: async () => persisted,
    writeSettings: async (raw) => (persisted = normalizeCodeIntelligenceSettings(raw)),
    resolveApiKey: async () => null,
    resolveSessionProviders: async () => [],
    listProcesses: async () => [],
    watchDirectory: (path, onChange) => {
      watched.set(path, onChange);
      return () => watched.delete(path);
    },
    fetchImpl: (async () => { throw new Error('no network in tests'); }) as typeof fetch,
    nowMs: Date.now,
    sweepIntervalMs: 60 * 60 * 1000,
  };
}

async function start(deps: CodeIntelligenceWorkerDeps): Promise<CodeIntelligenceWorkerHandle> {
  const worker = await startCodeIntelligenceWorker(deps);
  cleanups.push(() => worker.stop());
  return worker;
}

describe('code intelligence worker', () => {
  it('does nothing and reports disabled until the user opts in', async () => {
    const { root, repo } = await setupRepo();
    const worker = await start(buildDeps(root, {}, new Map()));

    expect(worker.getSnapshot({})).toMatchObject({ ok: false, errorCode: 'code_intelligence_disabled' });
    expect(await worker.registerRepository(repo)).toMatchObject({ ok: false, errorCode: 'code_intelligence_disabled' });
  });

  it('detects a commit from a git-dir change and preserves it for a client that reconnects after a restart', async () => {
    const { root, repo } = await setupRepo();
    const watched = new Map<string, () => void>();
    const deps = buildDeps(root, { enabled: true }, watched);
    const worker = await start(deps);

    const registered = await worker.registerRepository(repo);
    expect(registered).toMatchObject({ ok: true, repository: { displayName: 'shop' } });
    const [watchedDir] = [...watched.keys()];
    expect(watchedDir).toContain(join('.git', 'logs'));

    const before = worker.getSnapshot({});
    const cursor = before.ok ? before.latestSeq : 0;

    await writeFile(join(repo, 'cart.py'), 'def total(items):\n    return sum(items)\n');
    await git(repo, ['commit', '-am', 'fix: sum totals']);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    watched.get(watchedDir!)!();
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    // Only the watcher-triggered reconcile runs here; the periodic sweep is an hour away.
    await vi.waitFor(() => {
      const snapshot = worker.getSnapshot({ afterSeq: cursor });
      expect(snapshot.ok && snapshot.events.map((event) => event.kind)).toContain('analysis_skipped');
    }, { timeout: 10_000 });

    const incremental = worker.getSnapshot({ afterSeq: cursor });
    expect(incremental.ok && incremental.events.map((event) => event.kind)).toEqual(['commit_observed', 'analysis_skipped']);
    expect(incremental.ok && incremental.commits[0]).toMatchObject({
      subject: 'fix: sum totals',
      changedSymbols: [expect.objectContaining({ name: 'total', changeKind: 'modified' })],
      analysis: { status: 'skipped', reason: 'remote_analysis_disabled' },
    });

    await worker.stop();
    const restarted = await start(deps);
    const recovered = restarted.getSnapshot({ afterSeq: cursor });
    expect(recovered.ok && recovered.commits.map((commit) => commit.subject)).toEqual(['fix: sum totals']);
    expect(recovered.ok && recovered.events.map((event) => event.kind)).toEqual(['commit_observed', 'analysis_skipped']);
  });

  it('never hands API keys back to clients', async () => {
    const { root } = await setupRepo();
    const worker = await start(buildDeps(root, { enabled: true }, new Map()));

    const saved = await worker.setSettings({
      enabled: true,
      remoteAnalysis: { providers: [{ id: 'groq', kind: 'groq', modelId: 'm', billing: 'free', apiKey: { _isSecretValue: true, value: 'gsk_secret_value_123' } }] },
    });

    expect(JSON.stringify(saved)).not.toContain('gsk_secret_value_123');
    expect(JSON.stringify(worker.getSettings())).not.toContain('gsk_secret_value_123');
  });
});
