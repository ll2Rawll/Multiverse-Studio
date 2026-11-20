/**
 * Removes secrets from text before it is logged, persisted, shown in an error, or sent to a model.
 * Known secrets (the keys in the vault) are always removed; common key formats are removed too, so
 * a key the user pastes into a chat by accident is not stored or forwarded.
 */

const PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-or-v1-[A-Za-z0-9]{16,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:x-api-key|x-goog-api-key|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]{8,}/gi,
  /([?&](?:key|api_key|apikey|token)=)[^&\s"']{8,}/gi,
];

export const REDACTED = '[redacted]';

export class Redactor {
  private secrets: string[] = [];

  /** Replace the set of known secret values (e.g. after the vault changes). */
  setSecrets(values: Iterable<string>): void {
    this.secrets = [...new Set([...values].filter((v) => typeof v === 'string' && v.length >= 8))].sort((a, b) => b.length - a.length);
  }

  addSecret(value: string): void {
    if (value.length >= 8 && !this.secrets.includes(value)) this.setSecrets([...this.secrets, value]);
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    for (const pattern of PATTERNS) {
      out = out.replace(pattern, (match, prefix?: string) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED));
    }
    return out;
  }

  /** Deep-redact strings inside plain JSON values. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = /^(api[_-]?key|authorization|x-api-key|x-goog-api-key|secret|password|token)$/i.test(k) ? REDACTED : this.redactValue(v);
      return out as T;
    }
    return value;
  }
}

/** Process-wide redactor shared by the AI service, task store and loggers. */
export const redactor = new Redactor();
