import { watch } from 'node:fs';
import { join } from 'node:path';

import { listPassiveSessionObservationProviders } from '@/backends/catalog';
import { configuration } from '@/configuration';
import { listProcessSnapshot } from '@/daemon/processSnapshotCache';
import {
  readCodeIntelligenceSettingsFromDisk,
  resolveCodeIntelligenceProviderApiKey,
  writeCodeIntelligenceSettingsToDisk,
} from '@/settings/codeIntelligenceSettings';
import { logger } from '@/ui/logger';

import { startCodeIntelligenceWorker, type CodeIntelligenceWorkerHandle } from './codeIntelligenceWorker';

/**
 * Composes the worker with the daemon's real boundaries. The store lives beside the other
 * per-server daemon state so two daemons for different servers never share one writer.
 */
export async function startDaemonCodeIntelligenceWorker(): Promise<CodeIntelligenceWorkerHandle> {
  return await startCodeIntelligenceWorker({
    dbPath: join(configuration.activeServerDir, 'code-intelligence', 'code-intelligence.sqlite'),
    readSettings: readCodeIntelligenceSettingsFromDisk,
    writeSettings: writeCodeIntelligenceSettingsToDisk,
    resolveApiKey: resolveCodeIntelligenceProviderApiKey,
    resolveSessionProviders: async () => [...await listPassiveSessionObservationProviders()],
    listProcesses: async () => (await listProcessSnapshot()).map((process) => ({
      name: process.name,
      ...('cmd' in process && typeof process.cmd === 'string' ? { cmd: process.cmd } : {}),
    })),
    watchDirectory: (path, onChange) => {
      try {
        const watcher = watch(path, { persistent: false }, () => onChange());
        watcher.on('error', (error) => {
          logger.warn('[codeIntelligence] git directory watcher failed; periodic reconcile continues', { path, error });
          watcher.close();
        });
        return () => watcher.close();
      } catch (error) {
        logger.warn('[codeIntelligence] could not watch git directory', { path, error });
        return null;
      }
    },
    fetchImpl: fetch,
    nowMs: Date.now,
  });
}
