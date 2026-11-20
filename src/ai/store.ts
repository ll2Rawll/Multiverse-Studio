/**
 * Non-secret AI settings: connections, discovered models, capability records, routing, prices and
 * budgets. Stored as JSON next to the workspace. Contains no keys.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CAPABILITIES, JOBS, MEDIA_ADAPTERS, PROTOCOLS, PROVIDER_KINDS, DEFAULT_BUDGETS, DEFAULT_TOKEN_SAVER, type Budgets, type ConnectionConfig, type Routing, type TokenSaver } from '../shared/ai';
import { writeFileAtomic } from '../engine/store/atomic';

const capabilityRecord = z.object({
  state: z.enum(['verified', 'declared', 'unavailable', 'unknown']),
  source: z.enum(['provider-metadata', 'user', 'verification', 'request']),
  detail: z.string().max(500),
  at: z.string().max(40),
});

const modelRecord = z.object({
  id: z.string().min(1).max(300),
  label: z.string().max(300),
  source: z.enum(['discovered', 'manual']),
  capabilities: z.record(z.enum(CAPABILITIES), capabilityRecord),
  contextTokens: z.number().nullable(),
  pricing: z.object({ inputPerMTok: z.number().nullable(), outputPerMTok: z.number().nullable(), source: z.enum(['provider', 'user']) }).nullable(),
  lifecycle: z.string().max(40).nullable(),
});

export const connectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{4,64}$/),
  name: z.string().min(1).max(80),
  provider: z.enum(PROVIDER_KINDS),
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.string().max(500),
  authStyle: z.enum(['bearer', 'x-api-key', 'x-goog-api-key', 'none']),
  headers: z.record(z.string().max(100), z.string().max(500)),
  timeoutMs: z.number().int().min(1000).max(600_000),
  media: z.array(z.enum(MEDIA_ADAPTERS)),
  models: z.array(modelRecord).max(5000),
  lastTest: z.object({ ok: z.boolean(), at: z.string(), kind: z.string(), message: z.string().max(1000) }).nullable(),
  createdAt: z.string(),
});

const settingsSchema = z.object({
  version: z.literal(1),
  connections: z.array(connectionSchema).max(64),
  routing: z.record(z.enum(JOBS), z.object({ connectionId: z.string(), modelId: z.string() })),
  budgets: z.object({ perTaskUsd: z.number().min(0).nullable(), maxToolIterations: z.number().int().min(1).max(200), maxMinutes: z.number().min(1).max(240) }),
  // Added later: files written before it existed get the defaults.
  tokenSaver: z
    .object({ replies: z.enum(['standard', 'brief', 'minimal']), compactOutputs: z.boolean(), compactHistory: z.boolean(), promptCaching: z.boolean() })
    .default(DEFAULT_TOKEN_SAVER),
});

export interface AiSettings {
  connections: ConnectionConfig[];
  routing: Routing;
  budgets: Budgets;
  tokenSaver: TokenSaver;
}

export class AiSettingsStore {
  private cache: AiSettings | null = null;
  constructor(private readonly file: string) {}

  async read(): Promise<AiSettings> {
    if (this.cache) return this.cache;
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      if (parsed.success) {
        this.cache = { connections: parsed.data.connections as ConnectionConfig[], routing: parsed.data.routing as Routing, budgets: parsed.data.budgets, tokenSaver: parsed.data.tokenSaver };
        return this.cache;
      }
      // Keep an unreadable file for inspection instead of silently overwriting it.
      await fs.copyFile(this.file, `${this.file}.invalid-${Date.now()}`).catch(() => undefined);
    } catch {
      // missing file: first run
    }
    this.cache = { connections: [], routing: {}, budgets: { ...DEFAULT_BUDGETS }, tokenSaver: { ...DEFAULT_TOKEN_SAVER } };
    return this.cache;
  }

  private chain: Promise<unknown> = Promise.resolve();

  /** Updates run one at a time, so two quick changes (say, two model assignments) never overwrite each other. */
  update(fn: (s: AiSettings) => AiSettings | void): Promise<AiSettings> {
    const run = this.chain.then(() => this.apply(fn));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async apply(fn: (s: AiSettings) => AiSettings | void): Promise<AiSettings> {
    const current = structuredClone(await this.read());
    const next = fn(current) ?? current;
    const validated = settingsSchema.parse({ version: 1, ...next });
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(validated, null, 1));
    this.cache = { connections: validated.connections as ConnectionConfig[], routing: validated.routing as Routing, budgets: validated.budgets, tokenSaver: validated.tokenSaver };
    return this.cache;
  }
}
