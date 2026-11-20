import { ProviderError, classifyStatus } from './errors';
import { redactor } from './redact';
import type { AdapterContext } from './types';

export function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return path.startsWith('/') ? `${trimmed}${path}` : `${trimmed}/${path}`;
}

export function authHeaders(ctx: AdapterContext): Record<string, string> {
  const headers: Record<string, string> = { ...ctx.config.headers };
  const key = ctx.apiKey;
  if (key) {
    if (ctx.config.authStyle === 'bearer') headers.Authorization = `Bearer ${key}`;
    else if (ctx.config.authStyle === 'x-api-key') headers['x-api-key'] = key;
    else if (ctx.config.authStyle === 'x-goog-api-key') headers['x-goog-api-key'] = key;
  }
  return headers;
}

/** fetch with auth headers, a timeout, cancellation and classified, redacted errors. */
export async function providerFetch(ctx: AdapterContext, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; raw?: FormData | Blob | string } = {}): Promise<Response> {
  const url = /^https?:\/\//.test(path) ? path : joinUrl(ctx.config.baseUrl, path);
  const timeout = AbortSignal.timeout(init.timeoutMs ?? ctx.config.timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  const headers: Record<string, string> = { ...authHeaders(ctx), ...init.headers };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: init.method ?? (init.body !== undefined || init.raw !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      signal,
    });
  } catch (error) {
    if (ctx.signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
    if (timeout.aborted) throw new ProviderError('timeout', `No response from ${new URL(url).host} within ${Math.round((init.timeoutMs ?? ctx.config.timeoutMs) / 1000)} s.`);
    throw new ProviderError('network', redactor.redact(`Could not reach ${safeHost(url)}: ${(error as Error).message}`));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const kind = classifyStatus(response.status, text);
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ProviderError(kind, redactor.redact(`${response.status} ${response.statusText || ''}: ${extractMessage(text)}`.trim()), response.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
  return response;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the provider';
  }
}

export function extractMessage(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string; detail?: string };
    const err = json.error;
    const message = (typeof err === 'string' ? err : err?.message) ?? json.message ?? json.detail;
    if (typeof message === 'string') return message.slice(0, 500);
  } catch {
    // not JSON
  }
  return body.replace(/\s+/g, ' ').slice(0, 300);
}

export function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new ProviderError('invalid-response', 'The provider returned an empty stream.');
  return response.body;
}

export function wrapStreamError(error: unknown, signal?: AbortSignal): never {
  if (error instanceof ProviderError) throw error;
  if (signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
  if (error instanceof SyntaxError) throw new ProviderError('invalid-response', `The provider sent data that is not valid JSON: ${error.message}`);
  throw new ProviderError('network', redactor.redact(`The stream was interrupted: ${(error as Error).message}`));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseArgs(raw: string): { args: unknown; rawArgs?: string } {
  if (!raw.trim()) return { args: {} };
  try {
    return { args: JSON.parse(raw) };
  } catch {
    return { args: {}, rawArgs: raw };
  }
}
