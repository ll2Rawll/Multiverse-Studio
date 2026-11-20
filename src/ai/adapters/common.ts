import type { Capability, CapabilityRecord, CapabilityState } from '../../shared/ai';
import { nowIso } from '../http';

export function cap(state: CapabilityState, detail: string): CapabilityRecord {
  return { state, source: 'provider-metadata', detail, at: nowIso() };
}

export function caps(entries: [Capability, CapabilityState, string][]): Partial<Record<Capability, CapabilityRecord>> {
  const out: Partial<Record<Capability, CapabilityRecord>> = {};
  for (const [c, s, d] of entries) out[c] = cap(s, d);
  return out;
}

export function dataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

let counter = 0;
export function localCallId(): string {
  counter += 1;
  return `call_${Date.now().toString(36)}_${counter}`;
}
