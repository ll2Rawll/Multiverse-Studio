import type { Capability, CapabilityRecord, ConnectionConfig, ModelPricing, Protocol } from '../shared/ai';

/** Plain JSON-schema subset used for tool parameters; adapters translate it per provider. */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; dataBase64: string };

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  /** Raw argument text when it could not be parsed as JSON. */
  rawArgs?: string;
}

export type ChatMessage =
  | { role: 'user'; content: ContentPart[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError: boolean };

export interface GenerateRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Ask the provider to reuse the unchanged start of the request (Anthropic: cache breakpoints on the
   * tools, the system prompt and the latest message; OpenAI: a stable prompt_cache_key). Adapters
   * apply it only where the provider documents it.
   */
  cache?: { key: string } | null;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; call: ToolCall }
  /** inputTokens counts all input, cached or not; cachedInputTokens is the part read from the provider's cache. */
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null; cachedInputTokens?: number | null; cacheWriteTokens?: number | null }
  | { type: 'done'; stopReason: string | null };

export interface DiscoveredModel {
  id: string;
  label: string;
  capabilities: Partial<Record<Capability, CapabilityRecord>>;
  contextTokens: number | null;
  pricing: ModelPricing | null;
  lifecycle: string | null;
}

export interface AdapterContext {
  config: ConnectionConfig;
  /** The key for this request only; never stored by adapters. */
  apiKey: string | null;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Implement this to support a new API protocol. Register it in `adapters/index.ts` and add a
 * preset (or let users choose the protocol for a custom endpoint). Never report compatibility
 * without a successful request: discovery and tests must hit the real endpoint.
 */
export interface ProviderAdapter {
  readonly protocol: Protocol;
  listModels(ctx: AdapterContext): Promise<DiscoveredModel[]>;
  stream(ctx: AdapterContext, request: GenerateRequest): AsyncGenerator<StreamEvent>;
}
