import type { CodeIntelligenceAnalysisProviderKindV1 } from '@happier-dev/protocol';

/**
 * Documented OpenAI-compatible chat-completions base URLs (checked 2026-10). OpenCode Zen and Go
 * serve some models only through `responses`/`messages`/Google endpoints; those protocols are not
 * spoken here, so such models must be configured through a chat-completions compatible endpoint.
 */
const DEFAULT_BASE_URLS: Record<CodeIntelligenceAnalysisProviderKindV1, string | null> = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  opencode_zen: 'https://opencode.ai/inference/openai/v1',
  opencode_go: 'https://opencode.ai/inference/go/openai/v1',
  openai_compatible: null,
};

export function resolveChatCompletionBaseUrl(kind: CodeIntelligenceAnalysisProviderKindV1, configured: string | null): string | null {
  const value = configured ?? DEFAULT_BASE_URLS[kind];
  return value ? value.replace(/\/+$/, '') : null;
}

export type ChatCompletionResult =
  | Readonly<{ ok: true; content: string; inputTokens: number | null; outputTokens: number | null }>
  | Readonly<{ ok: false; kind: 'rate_limited'; retryAfterMs: number | null; status: number }>
  | Readonly<{ ok: false; kind: 'unavailable' | 'rejected' | 'invalid_response'; status: number | null; message: string }>;

/** `Retry-After` is either delta-seconds or an HTTP date (RFC 9110 §10.2.3). */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

export async function requestChatCompletion(input: Readonly<{
  baseUrl: string;
  apiKey: string | null;
  modelId: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  nowMs: () => number;
}>): Promise<ChatCompletionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: Response;
  try {
    response = await input.fetchImpl(`${input.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.modelId,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        temperature: 0,
        max_tokens: input.maxOutputTokens,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    return { ok: false, kind: 'unavailable', status: null, message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    return { ok: false, kind: 'rate_limited', status: 429, retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), input.nowMs()) };
  }
  if (response.status >= 500) {
    return { ok: false, kind: 'unavailable', status: response.status, message: `provider returned ${response.status}` };
  }
  if (!response.ok) {
    // Never echo the body: some providers reflect request headers or keys in error payloads.
    return { ok: false, kind: 'rejected', status: response.status, message: `provider rejected the request (${response.status})` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, kind: 'invalid_response', status: response.status, message: 'response was not JSON' };
  }
  const record = body as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  const content = record.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, kind: 'invalid_response', status: response.status, message: 'response had no message content' };
  }
  const toCount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null);
  return { ok: true, content, inputTokens: toCount(record.usage?.prompt_tokens), outputTokens: toCount(record.usage?.completion_tokens) };
}
