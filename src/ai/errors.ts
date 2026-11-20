import { PROVIDER_ERROR_HELP, type ProviderErrorKind } from '../shared/ai';

/** A provider failure classified so the UI can explain it and decide whether retrying is safe. */
export class ProviderError extends Error {
  readonly code = 'provider-error';
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null = null,
    /** Seconds the provider asked us to wait, when it said so. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get help(): string {
    return PROVIDER_ERROR_HELP[this.kind];
  }
}

export function classifyStatus(status: number, body: string): ProviderErrorKind {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || /insufficient_quota|quota|credit balance|billing/.test(lower)) return status === 429 || status === 402 ? 'quota' : 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 404) return 'not-found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 400 || status === 422) return /not support|unsupported|does not support|invalid model/.test(lower) ? 'unsupported' : 'bad-request';
  if (status >= 500) return 'server';
  return 'bad-request';
}
