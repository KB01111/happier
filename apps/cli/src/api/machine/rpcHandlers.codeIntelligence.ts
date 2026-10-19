import {
  CodeIntelligenceCommitAnalyzeRequestV1Schema,
  CodeIntelligenceRepositoryRegisterRequestV1Schema,
  CodeIntelligenceSnapshotRequestV1Schema,
  type CodeIntelligenceCommitAnalyzeResponseV1,
  type CodeIntelligenceRepositoryRegisterResponseV1,
  type CodeIntelligenceSettingsV1,
  type CodeIntelligenceSnapshotResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { CodeIntelligenceWorkerHandle } from '@/daemon/codeIntelligence/codeIntelligenceWorker';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

function invalidRequest(error: string) {
  return { ok: false as const, errorCode: 'invalid_request' as const, error };
}

/**
 * Typed, read-mostly surface over the daemon's code-intelligence worker. Nothing here executes
 * commands or touches a checkout beyond read-only git inspection.
 */
export function registerMachineCodeIntelligenceRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  worker: CodeIntelligenceWorkerHandle;
}>): void {
  const { rpcHandlerManager, worker } = params;

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SNAPSHOT_GET, async (raw: unknown): Promise<CodeIntelligenceSnapshotResponseV1> => {
    const parsed = CodeIntelligenceSnapshotRequestV1Schema.safeParse(raw ?? {});
    return parsed.success ? worker.getSnapshot(parsed.data) : invalidRequest('Invalid snapshot request');
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_REPOSITORY_REGISTER, async (raw: unknown): Promise<CodeIntelligenceRepositoryRegisterResponseV1> => {
    const parsed = CodeIntelligenceRepositoryRegisterRequestV1Schema.safeParse(raw);
    return parsed.success ? await worker.registerRepository(parsed.data.path) : invalidRequest('Invalid repository path');
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_COMMIT_ANALYZE, async (raw: unknown): Promise<CodeIntelligenceCommitAnalyzeResponseV1> => {
    const parsed = CodeIntelligenceCommitAnalyzeRequestV1Schema.safeParse(raw);
    return parsed.success ? await worker.requestCommitAnalysis(parsed.data) : invalidRequest('Invalid commit reference');
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SETTINGS_GET, async (): Promise<CodeIntelligenceSettingsV1> => worker.getSettings());

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SETTINGS_SET, async (raw: unknown): Promise<CodeIntelligenceSettingsV1> => {
    // Settings are replaced as a whole; a missing payload must not silently reset them to defaults.
    if (!raw || typeof raw !== 'object' || !('settings' in raw)) throw new Error('Expected { settings }');
    return await worker.setSettings((raw as { settings: unknown }).settings);
  });
}
