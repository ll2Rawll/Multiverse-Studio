import type { RequestBreakdown, TaskState, UsageTotals } from '../../shared/ai';

export const STATE_LABEL: Record<TaskState, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  'waiting-input': 'Waiting for you',
  cancelling: 'Cancelling',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

export function stateTone(state: TaskState): 'ok' | 'busy' | 'warn' | 'bad' | 'idle' {
  if (state === 'completed') return 'ok';
  if (state === 'running' || state === 'queued' || state === 'cancelling') return 'busy';
  if (state === 'paused' || state === 'waiting-input' || state === 'interrupted') return 'warn';
  if (state === 'failed') return 'bad';
  return 'idle';
}

/** Costs are always labelled as estimates, and unknown prices stay “Unknown”. */
export function costText(usage: UsageTotals): string {
  if (usage.requests === 0) return 'No requests yet';
  if (usage.estimatedCostUsd === null) return 'Cost: unknown';
  const value = usage.estimatedCostUsd < 0.01 ? usage.estimatedCostUsd.toFixed(4) : usage.estimatedCostUsd.toFixed(2);
  return `Estimated cost: $${value}${usage.partial ? ' (some prices unknown)' : ''}`;
}

export function tokenText(usage: UsageTotals): string {
  if (usage.inputTokens === null && usage.outputTokens === null) return 'Tokens: not reported';
  const cached = usage.cachedInputTokens ? ` (${compact(usage.cachedInputTokens)} cached)` : '';
  return `${(usage.inputTokens ?? 0).toLocaleString()} in${cached} · ${(usage.outputTokens ?? 0).toLocaleString()} out`;
}

const compact = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Tokens kept out of requests by the token saver: an estimate, and labelled as one. */
export function savedText(usage: UsageTotals): string | null {
  const n = usage.savedTokensEstimate ?? 0;
  return n >= 50 ? `About ${compact(n)} tokens saved` : null;
}

/** Where the latest request's tokens went (estimates from characters). */
export function breakdownText(b: RequestBreakdown): string {
  return `Last request, estimated: ${compact(b.instructions)} instructions · ${compact(b.tools)} tool definitions · ${compact(b.conversation)} conversation · ${compact(b.toolResults)} tool results${b.saved ? ` · ${compact(b.saved)} kept out by compaction` : ''}`;
}

export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
