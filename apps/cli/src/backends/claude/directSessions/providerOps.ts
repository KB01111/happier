import { getClaudeDirectSessionActivity } from './getClaudeDirectSessionActivity';
import { getClaudeDirectSessionWorkingDirectory } from './getClaudeDirectSessionWorkingDirectory';
import { listClaudeSessionCandidates } from './listClaudeSessionCandidates';
import { pageClaudeTranscript } from './pageClaudeTranscript';
import { readAfterClaudeTranscript } from './readAfterClaudeTranscript';
import { resolveClaudeConfigDirForDirectSessions } from './resolveClaudeConfigDir';

import { createPollingDirectSessionFollowLease } from '@/api/directSessions/backgroundFollow/createPollingDirectSessionFollowLease';
import {
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/backends/directSessions/providerOps';
import { bareNameMatches, pathContains, pathEndsWith, processTokens } from '@/backends/directSessions/processMatch';

export const claudeDirectSessionProviderOps: DirectSessionProviderOps = {
  listCandidates: async ({ source, cursor, limit, searchTerm, searchMode }) => {
    const res = await listClaudeSessionCandidates({ source, cursor, limit, searchTerm, searchMode });
    return { candidates: res.candidates, nextCursor: res.nextCursor ?? null, ...(res.searchIncomplete ? { searchIncomplete: true } : {}) };
  },
  getActivity: async ({ source, remoteSessionId }) => {
    const res = await getClaudeDirectSessionActivity({ source, remoteSessionId });
    return {
      lastActivityAtMs: typeof res.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) ? res.lastActivityAtMs : null,
      isRunning: false,
    };
  },
  getWorkingDirectory: async ({ source, remoteSessionId }) =>
    await getClaudeDirectSessionWorkingDirectory({ source, remoteSessionId, env: process.env }),
  // Listing reads `<CLAUDE_CONFIG_DIR>/projects/**` only.
  passiveObservationSource: () => ({ kind: 'claudeConfig' }),
  // Patterns from AgentMonitor's Claude adapter (MIT, see processMatch.ts).
  matchesProviderProcess: (observed) => processTokens(observed).some((token) =>
    pathEndsWith(token, '/bin/claude')
    || bareNameMatches(token, 'claude')
    || pathContains(token, '/.claude/local/')
    || pathContains(token, '/@anthropic-ai/claude-code')),
  pageTranscript: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems }) => {
    const res = await pageClaudeTranscript({ source, remoteSessionId, direction, cursor, maxBytes, maxItems });
    return {
      items: res.items,
      nextCursor: res.nextCursor ?? null,
      tailCursor: res.tailCursor ?? null,
      hasMore: res.hasMore,
      truncated: res.truncated === true,
    };
  },
  readAfterTranscript: async ({ source, remoteSessionId, cursor, maxBytes, maxItems }) => {
    const res = await readAfterClaudeTranscript({ source, remoteSessionId, cursor, maxBytes, maxItems });
    return { ...res, nextCursor: res.nextCursor ?? null, truncated: res.truncated === true };
  },
  acquireFollowLease: async ({ source, remoteSessionId }) => createPollingDirectSessionFollowLease({
    readAfterTranscript: ({ cursor, maxBytes, maxItems }) =>
      readAfterClaudeTranscript({ source, remoteSessionId, cursor, maxBytes, maxItems }),
  }),
  resolveTakeoverSpawnOptions: async ({ linked, sessionId }) => {
    const configDir = resolveClaudeConfigDirForDirectSessions({ source: linked.source, env: process.env });
    const directory =
      linked.sessionPath ??
      (await getClaudeDirectSessionWorkingDirectory({
        source: linked.source,
        remoteSessionId: linked.remoteSessionId,
        env: process.env,
      }));
    if (!directory) return null;
    return {
      directory,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: sessionId,
      resume: linked.remoteSessionId,
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      environmentVariables: mergeDirectSessionEnvironmentVariables([{ CLAUDE_CONFIG_DIR: configDir }]),
    };
  },
};
