/**
 * AiService: connections, keys, discovery, capability records, routing and model requests.
 * Runs in the engine worker (or the harness server). Keys come from the vault for each request and
 * are never returned, logged or written to project files.
 */
import { randomUUID } from 'node:crypto';
import {
  CAPABILITY_LABELS,
  JOB_INFO,
  presetFor,
  type AiStateView,
  type Budgets,
  type Capability,
  type CapabilityRecord,
  type CapabilityState,
  type ConnectionConfig,
  type ConnectionTestResult,
  type ConnectionView,
  type Job,
  type MediaAdapterId,
  type ModelRecord,
  type Protocol,
  type ProviderKind,
  type RouteAssignment,
  type TokenSaver,
} from '../shared/ai';
import { adapterFor } from './adapters';
import { ProviderError } from './errors';
import { nowIso } from './http';
import { redactor } from './redact';
import { AiSettingsStore } from './store';
import type { KeyPersistence, SecretVault } from './vault';
import type { AdapterContext, DiscoveredModel, GenerateRequest, StreamEvent } from './types';

export interface SaveConnectionInput {
  id?: string;
  name: string;
  provider: ProviderKind;
  protocol: Protocol;
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  media?: MediaAdapterId[];
}

export interface ResolvedRoute {
  connection: ConnectionConfig;
  model: ModelRecord;
  local: boolean;
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;
const FORBIDDEN_HEADERS = /^(authorization|proxy-authorization|cookie)$|api[-_]?key|token|secret|password|credential/i;
const STATE_RANK: Record<CapabilityState, number> = { verified: 3, declared: 2, unknown: 1, unavailable: 0 };

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function capabilityState(model: ModelRecord, capability: Capability): CapabilityState {
  return model.capabilities[capability]?.state ?? 'unknown';
}

export class AiService {
  readonly store: AiSettingsStore;

  constructor(
    settingsFile: string,
    readonly vault: SecretVault,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.store = new AiSettingsStore(settingsFile);
    void this.refreshRedactor();
  }

  private async refreshRedactor(): Promise<void> {
    redactor.setSecrets(await this.vault.values().catch(() => []));
  }

  /* ---------------- state ---------------- */

  async state(): Promise<AiStateView> {
    const settings = await this.store.read();
    const connections: ConnectionView[] = [];
    for (const c of settings.connections) {
      const preset = presetFor(c.provider);
      connections.push({ ...c, key: await this.vault.describe(c.id), requiresKey: preset.requiresKey, local: isLocalUrl(c.baseUrl) });
    }
    return { connections, routing: settings.routing, budgets: settings.budgets, tokenSaver: settings.tokenSaver, vault: await this.vault.status() };
  }

  async connection(id: string): Promise<ConnectionConfig> {
    const c = (await this.store.read()).connections.find((x) => x.id === id);
    if (!c) throw new ProviderError('not-configured', 'That provider connection no longer exists.');
    return c;
  }

  /* ---------------- connections and keys ---------------- */

  async saveConnection(input: SaveConnectionInput): Promise<string> {
    const preset = presetFor(input.provider);
    if (!preset.protocols.includes(input.protocol)) {
      throw new ProviderError('unsupported', `${preset.label} connections support ${preset.protocols.join(' or ')}, not ${input.protocol}. APIs with a different wire format need their own adapter.`);
    }
    let url: URL;
    try {
      url = new URL(input.baseUrl.trim());
    } catch {
      throw new ProviderError('bad-request', 'Enter a full base URL, such as https://api.example.com/v1.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ProviderError('bad-request', 'The base URL must start with https:// (or http:// for a server on this computer).');
    if (url.protocol === 'http:' && !LOCAL_HOST.test(url.hostname)) {
      throw new ProviderError('bad-request', 'Plain http:// is only allowed for servers on this computer, because keys would be sent unencrypted. Use https://.');
    }
    if (url.username || url.password) throw new ProviderError('bad-request', 'Put credentials in the API key field, not in the URL.');
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      // Headers are saved as plain settings: anything that looks like a credential belongs in the key field.
      if (FORBIDDEN_HEADERS.test(name) || redactor.redact(String(value)) !== String(value)) throw new ProviderError('bad-request', `Put credentials in the API key field instead of the “${name}” header, so they are stored securely.`);
    }
    const id = input.id ?? `${input.provider}-${randomUUID().slice(0, 8)}`;
    await this.store.update((s) => {
      const existing = s.connections.find((c) => c.id === id);
      const next: ConnectionConfig = {
        id,
        name: input.name.trim() || preset.label,
        provider: input.provider,
        protocol: input.protocol,
        baseUrl: url.toString().replace(/\/+$/, ''),
        authStyle: preset.authStyle,
        headers: input.headers ?? existing?.headers ?? {},
        timeoutMs: input.timeoutMs ?? existing?.timeoutMs ?? 120_000,
        // Endpoints the provider documents are on by default; optional ones (OpenAI-compatible servers) only when turned on.
        media: (input.media ?? existing?.media ?? preset.media).filter((m) => preset.media.includes(m) || (preset.mediaOptional ?? []).includes(m)),
        // Changing protocol or address invalidates what we learned about the models.
        models: existing && existing.baseUrl === url.toString().replace(/\/+$/, '') && existing.protocol === input.protocol ? existing.models : [],
        lastTest: existing && existing.baseUrl === url.toString().replace(/\/+$/, '') && existing.protocol === input.protocol ? existing.lastTest : null,
        createdAt: existing?.createdAt ?? nowIso(),
      };
      s.connections = existing ? s.connections.map((c) => (c.id === id ? next : c)) : [...s.connections, next];
    });
    return id;
  }

  async deleteConnection(id: string): Promise<void> {
    await this.vault.delete(id);
    await this.store.update((s) => {
      s.connections = s.connections.filter((c) => c.id !== id);
      for (const job of Object.keys(s.routing) as Job[]) if (s.routing[job]?.connectionId === id) delete s.routing[job];
    });
    await this.refreshRedactor();
  }

  async setKey(id: string, key: string, persistence: KeyPersistence): Promise<void> {
    await this.connection(id);
    const trimmed = key.trim();
    if (trimmed.length < 8 || /\s/.test(trimmed)) throw new ProviderError('bad-request', 'That does not look like an API key.');
    redactor.addSecret(trimmed);
    await this.vault.set(id, trimmed, persistence);
    await this.store.update((s) => {
      const c = s.connections.find((x) => x.id === id);
      if (c) c.lastTest = null;
    });
  }

  async clearKey(id: string): Promise<void> {
    await this.vault.delete(id);
    await this.refreshRedactor();
  }

  private async context(connection: ConnectionConfig, signal?: AbortSignal): Promise<AdapterContext> {
    const preset = presetFor(connection.provider);
    const apiKey = connection.authStyle === 'none' ? null : await this.vault.get(connection.id);
    if (preset.requiresKey && !apiKey) throw new ProviderError('not-configured', `Add an API key for ${connection.name} first.`);
    return { config: connection, apiKey, fetch: this.fetchImpl, signal };
  }

  /* ---------------- discovery and testing ---------------- */

  /** Test the connection by listing models. Records the outcome; never claims more than was checked. */
  async test(id: string): Promise<ConnectionTestResult & { modelCount: number }> {
    const connection = await this.connection(id);
    let result: ConnectionTestResult;
    let count = 0;
    try {
      const models = await adapterFor(connection.protocol).listModels(await this.context(connection));
      count = models.length;
      await this.mergeModels(id, models);
      result = { ok: true, at: nowIso(), kind: 'ok', message: count ? `Connected. ${count} model${count === 1 ? '' : 's'} available.` : 'Connected, but the provider listed no models. Add a model id manually.' };
    } catch (error) {
      const e = error instanceof ProviderError ? error : new ProviderError('network', String((error as Error).message));
      result = { ok: false, at: nowIso(), kind: e.kind, message: redactor.redact(`${e.message} ${e.help}`) };
    }
    await this.store.update((s) => {
      const c = s.connections.find((x) => x.id === id);
      if (c) c.lastTest = result;
    });
    return { ...result, modelCount: count };
  }

  private async mergeModels(id: string, discovered: DiscoveredModel[]): Promise<void> {
    await this.store.update((s) => {
      const c = s.connections.find((x) => x.id === id);
      if (!c) return;
      const byId = new Map(c.models.map((m) => [m.id, m]));
      for (const d of discovered) {
        const prev = byId.get(d.id);
        const capabilities: Partial<Record<Capability, CapabilityRecord>> = { ...d.capabilities };
        // Verified results and the user's own declarations outrank fresh metadata.
        for (const [k, v] of Object.entries(prev?.capabilities ?? {}) as [Capability, CapabilityRecord][]) {
          if (v.source === 'verification' || v.source === 'user' || v.source === 'request') capabilities[k] = v;
        }
        byId.set(d.id, {
          id: d.id,
          label: d.label,
          source: 'discovered',
          capabilities,
          contextTokens: d.contextTokens,
          pricing: prev?.pricing?.source === 'user' ? prev.pricing : d.pricing,
          lifecycle: d.lifecycle,
        });
      }
      c.models = [...byId.values()];
    });
  }

  async addModel(id: string, modelId: string, label?: string): Promise<void> {
    const trimmed = modelId.trim();
    if (!trimmed || trimmed.length > 300) throw new ProviderError('bad-request', 'Enter the model identifier exactly as the provider documents it.');
    await this.store.update((s) => {
      const c = s.connections.find((x) => x.id === id);
      if (!c) throw new ProviderError('not-configured', 'That provider connection no longer exists.');
      if (c.models.some((m) => m.id === trimmed)) return;
      c.models.push({ id: trimmed, label: label?.trim() || trimmed, source: 'manual', capabilities: {}, contextTokens: null, pricing: null, lifecycle: null });
    });
  }

  async removeModel(id: string, modelId: string): Promise<void> {
    await this.store.update((s) => {
      const c = s.connections.find((x) => x.id === id);
      if (c) c.models = c.models.filter((m) => m.id !== modelId);
      for (const job of Object.keys(s.routing) as Job[]) if (s.routing[job]?.connectionId === id && s.routing[job]?.modelId === modelId) delete s.routing[job];
    });
  }

  async setCapability(id: string, modelId: string, capability: Capability, state: 'declared' | 'unavailable' | 'unknown'): Promise<void> {
    await this.updateCapability(id, modelId, capability, { state, source: 'user', detail: state === 'unknown' ? 'Cleared by you' : `Set by you`, at: nowIso() });
  }

  private async updateCapability(id: string, modelId: string, capability: Capability, record: CapabilityRecord): Promise<void> {
    await this.store.update((s) => {
      const model = s.connections.find((x) => x.id === id)?.models.find((m) => m.id === modelId);
      if (!model) throw new ProviderError('not-found', 'That model is not in this connection.');
      if (record.state === 'unknown' && record.source === 'user') delete model.capabilities[capability];
      else model.capabilities[capability] = record;
    });
  }

  async setPricing(id: string, modelId: string, inputPerMTok: number | null, outputPerMTok: number | null): Promise<void> {
    await this.store.update((s) => {
      const model = s.connections.find((x) => x.id === id)?.models.find((m) => m.id === modelId);
      if (!model) throw new ProviderError('not-found', 'That model is not in this connection.');
      model.pricing = inputPerMTok === null && outputPerMTok === null ? null : { inputPerMTok, outputPerMTok, source: 'user' };
    });
  }

  /**
   * Verify a text-family capability with a tiny real request. This costs a few tokens on paid
   * providers, so it only runs when the user asks.
   */
  async verify(id: string, modelId: string, capability: 'text' | 'code' | 'tools'): Promise<CapabilityRecord> {
    const connection = await this.connection(id);
    const ctx = await this.context(connection, AbortSignal.timeout(60_000));
    const request: GenerateRequest =
      capability === 'tools'
        ? {
            model: modelId,
            maxOutputTokens: 200,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Call the report_status tool with status "ok". Do not answer in text.' }] }],
            tools: [{ name: 'report_status', description: 'Report a status string.', parameters: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } }],
          }
        : capability === 'code'
          ? { model: modelId, maxOutputTokens: 120, messages: [{ role: 'user', content: [{ type: 'text', text: 'Write a JavaScript function named add that returns the sum of two numbers. Reply with code only.' }] }] }
          : { model: modelId, maxOutputTokens: 20, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }] }] };
    let record: CapabilityRecord;
    try {
      let text = '';
      let toolCalls = 0;
      for await (const ev of adapterFor(connection.protocol).stream(ctx, request)) {
        if (ev.type === 'text') text += ev.delta;
        if (ev.type === 'tool-call') toolCalls += 1;
      }
      const ok = capability === 'tools' ? toolCalls > 0 : capability === 'code' ? /function\s+add|add\s*=|=>/.test(text) : text.trim().length > 0;
      record = ok
        ? { state: 'verified', source: 'verification', detail: `A test request succeeded ${new Date().toLocaleDateString()}`, at: nowIso() }
        : { state: 'unknown', source: 'verification', detail: capability === 'tools' ? 'The model answered but did not call the test tool.' : 'The model returned an empty answer.', at: nowIso() };
    } catch (error) {
      const e = error instanceof ProviderError ? error : new ProviderError('network', String((error as Error).message));
      if (e.kind === 'unsupported' || (e.kind === 'bad-request' && capability === 'tools')) {
        record = { state: 'unavailable', source: 'verification', detail: redactor.redact(e.message), at: nowIso() };
      } else {
        throw e; // auth, network or rate limits say nothing about the capability itself
      }
    }
    await this.updateCapability(id, modelId, capability, record);
    return record;
  }

  /* ---------------- routing ---------------- */

  /** Models able to do a job, best first. */
  async candidates(job: Job): Promise<{ connection: ConnectionConfig; model: ModelRecord; rank: number; missing: Capability[] }[]> {
    const settings = await this.store.read();
    const out: { connection: ConnectionConfig; model: ModelRecord; rank: number; missing: Capability[] }[] = [];
    for (const connection of settings.connections) {
      for (const model of connection.models) {
        const states = JOB_INFO[job].requires.map((c) => capabilityState(model, c));
        if (states.includes('unavailable')) continue;
        const rank = Math.min(...states.map((s) => STATE_RANK[s]));
        const missing = JOB_INFO[job].requires.filter((c) => capabilityState(model, c) === 'unknown');
        const localBonus = job === 'private-text' && isLocalUrl(connection.baseUrl) ? 10 : 0;
        if (job === 'private-text' && !isLocalUrl(connection.baseUrl)) continue;
        out.push({ connection, model, rank: rank + localBonus, missing });
      }
    }
    return out.sort((a, b) => b.rank - a.rank);
  }

  async setRoute(job: Job, assignment: RouteAssignment | null): Promise<void> {
    if (assignment) {
      const connection = await this.connection(assignment.connectionId);
      const model = connection.models.find((m) => m.id === assignment.modelId);
      if (!model) throw new ProviderError('not-found', 'Add the model to the connection first.');
      const blocked = JOB_INFO[job].requires.filter((c) => capabilityState(model, c) === 'unavailable');
      if (blocked.length) {
        const alt = (await this.candidates(job))[0];
        throw new ProviderError(
          'unsupported',
          `${model.label} cannot do ${blocked.map((c) => CAPABILITY_LABELS[c].toLowerCase()).join(' or ')}.${alt ? ` ${alt.model.label} on ${alt.connection.name} can.` : ''}`,
        );
      }
      if (job === 'private-text' && !isLocalUrl(connection.baseUrl)) throw new ProviderError('bad-request', 'Private text tasks must use a model on this computer (Ollama, LM Studio or another local server).');
    }
    await this.store.update((s) => {
      if (assignment) s.routing[job] = assignment;
      else delete s.routing[job];
    });
  }

  async setBudgets(budgets: Budgets): Promise<void> {
    await this.store.update((s) => {
      s.budgets = budgets;
    });
  }

  async setTokenSaver(tokenSaver: TokenSaver): Promise<void> {
    await this.store.update((s) => {
      s.tokenSaver = tokenSaver;
    });
  }

  /** The configured model for a job, or a precise explanation of what is missing. */
  async resolve(job: Job): Promise<ResolvedRoute> {
    const settings = await this.store.read();
    // The coding agent falls back to the assistant's model; capability checks below still apply.
    const chosen = settings.routing[job] ?? (job === 'coding' ? settings.routing.assistant : undefined);
    if (!chosen) {
      const alt = (await this.candidates(job))[0];
      throw new ProviderError(
        'not-configured',
        `No model is assigned to “${JOB_INFO[job].label}”. ${alt ? `Assign one in Settings → Models, for example ${alt.model.label} on ${alt.connection.name}.` : settings.connections.length ? 'None of your connected models is known to support it yet.' : 'Connect a provider in Settings → Providers first.'}`,
      );
    }
    const connection = settings.connections.find((c) => c.id === chosen.connectionId);
    const model = connection?.models.find((m) => m.id === chosen.modelId);
    if (!connection || !model) throw new ProviderError('not-configured', `The model assigned to “${JOB_INFO[job].label}” was removed. Choose another in Settings → Models.`);
    const blocked = JOB_INFO[job].requires.filter((c) => capabilityState(model, c) === 'unavailable');
    if (blocked.length) throw new ProviderError('unsupported', `${model.label} cannot do ${blocked.map((c) => CAPABILITY_LABELS[c].toLowerCase()).join(' or ')}.`);
    return { connection, model, local: isLocalUrl(connection.baseUrl) };
  }

  /** Stream a model request for a resolved route. */
  async *generate(route: ResolvedRoute, request: Omit<GenerateRequest, 'model'>, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const ctx = await this.context(route.connection, signal);
    const redacted: GenerateRequest = {
      ...request,
      model: route.model.id,
      system: request.system ? redactor.redact(request.system) : undefined,
      messages: request.messages.map((m) =>
        m.role === 'user'
          ? { ...m, content: m.content.map((p) => (p.type === 'text' ? { ...p, text: redactor.redact(p.text) } : p)) }
          : m.role === 'tool'
            ? { ...m, content: redactor.redact(m.content) }
            : { ...m, text: redactor.redact(m.text) },
      ),
    };
    let sawToolCall = false;
    let sawText = false;
    try {
      for await (const ev of adapterFor(route.connection.protocol).stream(ctx, redacted)) {
        if (ev.type === 'tool-call') sawToolCall = true;
        if (ev.type === 'text' && ev.delta.trim()) sawText = true;
        yield ev;
      }
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'unsupported' && request.tools?.length) {
        await this.updateCapability(route.connection.id, route.model.id, 'tools', { state: 'unavailable', source: 'request', detail: redactor.redact(error.message), at: nowIso() }).catch(() => undefined);
      }
      throw error;
    }
    if (sawText && capabilityState(route.model, 'text') !== 'verified') {
      await this.updateCapability(route.connection.id, route.model.id, 'text', { state: 'verified', source: 'request', detail: 'The model answered a task', at: nowIso() }).catch(() => undefined);
    }
    // A real tool call is proof the capability works; record it so routing can rely on it.
    if (sawToolCall && capabilityState(route.model, 'tools') !== 'verified') {
      await this.updateCapability(route.connection.id, route.model.id, 'tools', { state: 'verified', source: 'request', detail: 'The model made tool calls in a task', at: nowIso() }).catch(() => undefined);
    }
  }

  /* ---------------- media requests ---------------- */

  /** The route for a specific connection and model (used to keep following a job after a restart). */
  async routeFor(connectionId: string, modelId: string): Promise<ResolvedRoute> {
    const settings = await this.store.read();
    const connection = settings.connections.find((c) => c.id === connectionId);
    const model = connection?.models.find((m) => m.id === modelId) ?? (connection ? { id: modelId, label: modelId, source: 'manual' as const, capabilities: {}, contextTokens: null, pricing: null, lifecycle: null } : undefined);
    if (!connection || !model) throw new ProviderError('not-configured', 'The connection this job used was removed. Add it again in Settings → Providers to check the job.');
    return { connection, model, local: isLocalUrl(connection.baseUrl) };
  }

  /** Request context for a media adapter. The key is read from the vault for this request only. */
  mediaContext(route: ResolvedRoute, signal?: AbortSignal): Promise<AdapterContext> {
    return this.context(route.connection, signal);
  }

  /** A successful media request proves the capability; record it so routing can rely on it. */
  async markVerified(route: ResolvedRoute, capability: Capability, detail: string): Promise<void> {
    if (capabilityState(route.model, capability) === 'verified') return;
    await this.updateCapability(route.connection.id, route.model.id, capability, { state: 'verified', source: 'request', detail, at: nowIso() }).catch(() => undefined);
  }

  /** Estimated cost in USD, or null when the price is unknown. Labelled as an estimate in the UI. */
  estimateCost(model: ModelRecord, inputTokens: number | null, outputTokens: number | null): number | null {
    const p = model.pricing;
    if (!p || inputTokens === null || outputTokens === null || p.inputPerMTok === null || p.outputPerMTok === null) return null;
    return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
  }
}
