/**
 * Shared, serialisable types for AI connections, models, capabilities, routing, usage and tasks.
 * Used by the renderer (views) and by the Node side (`src/ai`). Nothing here holds a secret:
 * API keys live only in the main-process vault and are referenced by connection id.
 */

/* ---------------- capabilities ---------------- */

export const CAPABILITIES = [
  'text',
  'code',
  'vision',
  'tools',
  'structured-output',
  'image-generation',
  'speech-recognition',
  'speech-generation',
  'video-generation',
  'video-understanding',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  text: 'Text generation',
  code: 'Code generation',
  vision: 'Image understanding',
  tools: 'Tool calling',
  'structured-output': 'Structured output',
  'image-generation': 'Image generation',
  'speech-recognition': 'Speech recognition',
  'speech-generation': 'Speech generation',
  'video-generation': 'Video generation',
  'video-understanding': 'Video understanding',
};

/**
 * - `verified`: a real request using this capability succeeded.
 * - `declared`: the provider's metadata (or the user) says the model supports it; not yet exercised.
 * - `unavailable`: the provider's metadata says no, or a request failed because it is unsupported.
 * - `unknown`: nothing is known.
 */
export type CapabilityState = 'verified' | 'declared' | 'unavailable' | 'unknown';
export type CapabilitySource = 'provider-metadata' | 'user' | 'verification' | 'request';

export interface CapabilityRecord {
  state: CapabilityState;
  source: CapabilitySource;
  detail: string;
  at: string;
}

/* ---------------- providers, protocols and connections ---------------- */

export const PROTOCOLS = ['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini', 'ollama'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  'openai-responses': 'OpenAI Responses API',
  'openai-chat': 'OpenAI-compatible Chat Completions',
  'anthropic-messages': 'Anthropic Messages API',
  gemini: 'Google Gemini API (generateContent)',
  ollama: 'Ollama native API',
};

export const PROVIDER_KINDS = ['openai', 'anthropic', 'gemini', 'openrouter', 'ollama', 'lmstudio', 'openai-compatible', 'anthropic-compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export type AuthStyle = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';
export type DiscoveryKind = 'openai-models' | 'anthropic-models' | 'gemini-models' | 'openrouter-models' | 'ollama-tags' | 'none';

/** Media adapters are separate from chat protocols: a connection can offer one or more. */
export const MEDIA_ADAPTERS = ['openai-images', 'openai-transcriptions', 'gemini-image', 'gemini-speech', 'gemini-omni-video'] as const;
export type MediaAdapterId = (typeof MEDIA_ADAPTERS)[number];

export const MEDIA_ADAPTER_INFO: Record<MediaAdapterId, { label: string; capability: Capability; endpoint: string }> = {
  'openai-images': { label: 'Images API (POST /images/generations)', capability: 'image-generation', endpoint: '/images/generations' },
  'openai-transcriptions': { label: 'Audio transcriptions (POST /audio/transcriptions)', capability: 'speech-recognition', endpoint: '/audio/transcriptions' },
  'gemini-image': { label: 'Gemini Interactions image output (POST /interactions)', capability: 'image-generation', endpoint: '/interactions' },
  'gemini-speech': { label: 'Gemini Interactions speech output (POST /interactions)', capability: 'speech-generation', endpoint: '/interactions' },
  'gemini-omni-video': { label: 'Gemini Interactions video output (POST /interactions)', capability: 'video-generation', endpoint: '/interactions' },
};

export interface ProviderPreset {
  provider: ProviderKind;
  label: string;
  protocol: Protocol;
  /** Protocols the user may pick for this provider (custom endpoints offer several). */
  protocols: Protocol[];
  baseUrl: string;
  authStyle: AuthStyle;
  requiresKey: boolean;
  discovery: DiscoveryKind;
  media: MediaAdapterId[];
  /** Media endpoints the user may turn on for this kind of connection (off by default). */
  mediaOptional?: MediaAdapterId[];
  local: boolean;
  docsUrl: string;
  note: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    provider: 'openai',
    label: 'OpenAI',
    protocol: 'openai-responses',
    protocols: ['openai-responses', 'openai-chat'],
    baseUrl: 'https://api.openai.com/v1',
    authStyle: 'bearer',
    requiresKey: true,
    discovery: 'openai-models',
    media: ['openai-images', 'openai-transcriptions'],
    local: false,
    docsUrl: 'https://developers.openai.com/api/docs',
    note: 'Text, code and tools through the Responses API. Image generation and transcription use their own endpoints. OpenAI’s Sora video API was shut down in September 2026, so it is not offered.',
  },
  {
    provider: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic-messages',
    protocols: ['anthropic-messages'],
    baseUrl: 'https://api.anthropic.com/v1',
    authStyle: 'x-api-key',
    requiresKey: true,
    discovery: 'anthropic-models',
    media: [],
    local: false,
    docsUrl: 'https://platform.claude.com/docs',
    note: 'Text, code, image understanding and tools through the Messages API. Model capabilities are read from the Models API.',
  },
  {
    provider: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    protocols: ['gemini'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authStyle: 'x-goog-api-key',
    requiresKey: true,
    discovery: 'gemini-models',
    media: ['gemini-image', 'gemini-speech', 'gemini-omni-video'],
    local: false,
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    note: 'Text, code, vision and tools through generateContent. Video generation uses the Interactions API with a video response format.',
  },
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-chat',
    protocols: ['openai-chat'],
    baseUrl: 'https://openrouter.ai/api/v1',
    authStyle: 'bearer',
    requiresKey: true,
    discovery: 'openrouter-models',
    media: ['openai-transcriptions'],
    local: false,
    docsUrl: 'https://openrouter.ai/docs',
    note: 'Many providers behind one OpenAI-compatible endpoint. Model modalities, tool support and per-token prices come from its Models API.',
  },
  {
    provider: 'ollama',
    label: 'Ollama (local)',
    protocol: 'ollama',
    protocols: ['ollama', 'openai-chat'],
    baseUrl: 'http://localhost:11434',
    authStyle: 'none',
    requiresKey: false,
    discovery: 'ollama-tags',
    media: [],
    local: true,
    docsUrl: 'https://docs.ollama.com',
    note: 'Runs models on this computer. Requests never leave it. Install and pull a model in Ollama first.',
  },
  {
    provider: 'lmstudio',
    label: 'LM Studio (local)',
    protocol: 'openai-chat',
    protocols: ['openai-chat'],
    baseUrl: 'http://localhost:1234/v1',
    authStyle: 'none',
    requiresKey: false,
    discovery: 'openai-models',
    media: [],
    local: true,
    docsUrl: 'https://lmstudio.ai/docs',
    note: 'Uses LM Studio’s local OpenAI-compatible server. Start the server in LM Studio first.',
  },
  {
    provider: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    protocol: 'openai-chat',
    protocols: ['openai-chat', 'openai-responses'],
    baseUrl: '',
    authStyle: 'bearer',
    requiresKey: false,
    discovery: 'openai-models',
    media: [],
    mediaOptional: ['openai-transcriptions', 'openai-images'],
    local: false,
    docsUrl: '',
    note: 'For servers that implement the OpenAI Chat Completions (or Responses) wire format, such as vLLM, llama.cpp server or a gateway you run. Compatibility is only reported after a successful test.',
  },
  {
    provider: 'anthropic-compatible',
    label: 'Anthropic-compatible endpoint',
    protocol: 'anthropic-messages',
    protocols: ['anthropic-messages'],
    baseUrl: '',
    authStyle: 'x-api-key',
    requiresKey: false,
    discovery: 'anthropic-models',
    media: [],
    local: false,
    docsUrl: '',
    note: 'For gateways that implement the Anthropic Messages wire format.',
  },
];

export function presetFor(provider: ProviderKind): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.provider === provider)!;
}

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number | null;
  /** USD per million output tokens. */
  outputPerMTok: number | null;
  source: 'provider' | 'user';
}

export interface ModelRecord {
  id: string;
  label: string;
  source: 'discovered' | 'manual';
  capabilities: Partial<Record<Capability, CapabilityRecord>>;
  contextTokens: number | null;
  pricing: ModelPricing | null;
  lifecycle: string | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  at: string;
  kind: ProviderErrorKind | 'ok';
  message: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  provider: ProviderKind;
  protocol: Protocol;
  baseUrl: string;
  authStyle: AuthStyle;
  /** Extra, non-secret request headers from advanced settings. */
  headers: Record<string, string>;
  timeoutMs: number;
  media: MediaAdapterId[];
  models: ModelRecord[];
  lastTest: ConnectionTestResult | null;
  createdAt: string;
}

export type KeyStorage = 'os-encrypted' | 'session' | 'none';

export interface VaultStatus {
  /** True when keys can be saved across restarts with OS-backed encryption. */
  persistent: boolean;
  backend: string;
  detail: string;
}

export interface ConnectionView extends ConnectionConfig {
  key: { present: boolean; storage: KeyStorage };
  requiresKey: boolean;
  local: boolean;
}

/* ---------------- jobs and routing ---------------- */

export const JOBS = ['assistant', 'director', 'coding', 'visual-inspection', 'private-text', 'image-generation', 'transcription', 'speech-generation', 'video-generation'] as const;
export type Job = (typeof JOBS)[number];

export const JOB_INFO: Record<Job, { label: string; requires: Capability[]; description: string }> = {
  assistant: { label: 'Assistant', requires: ['text'], description: 'Answers questions and explains your project.' },
  director: { label: 'Director', requires: ['code'], description: 'Runs Plan, Build and Autopilot tasks across workspaces. Leave empty to use the Coding agent’s model.' },
  coding: { label: 'Coding agent', requires: ['code', 'tools'], description: 'Plans and edits code, runs commands and tests.' },
  'visual-inspection': { label: 'Visual inspection', requires: ['vision'], description: 'Looks at screenshots of pages for the director (look_at_page).' },
  'private-text': { label: 'Private text tasks', requires: ['text'], description: 'Summaries and wording that should stay on a local model.' },
  'image-generation': { label: 'Image generation', requires: ['image-generation'], description: 'Creates images for pages and videos.' },
  transcription: { label: 'Transcription', requires: ['speech-recognition'], description: 'Turns speech in footage into captions.' },
  'speech-generation': { label: 'Voice-over', requires: ['speech-generation'], description: 'Generates narration.' },
  'video-generation': { label: 'Video generation', requires: ['video-generation'], description: 'Creates video clips from prompts.' },
};

export interface RouteAssignment {
  connectionId: string;
  modelId: string;
}
export type Routing = Partial<Record<Job, RouteAssignment>>;

export interface Budgets {
  /** Per-task spending limit in USD; only enforceable when the model's prices are known. */
  perTaskUsd: number | null;
  maxToolIterations: number;
  maxMinutes: number;
}

export const DEFAULT_BUDGETS: Budgets = { perTaskUsd: null, maxToolIterations: 24, maxMinutes: 20 };

/** How tasks keep their token use down. All of it is plain English; nothing rewrites the user's words. */
export interface TokenSaver {
  /** Standard: as before. Brief: answer first, no preamble or recap. Minimal: results only, a few lines. */
  replies: 'standard' | 'brief' | 'minimal';
  /** Shorten noisy tool results (logs, test output, JSON); the full text stays on disk and can be read again. */
  compactOutputs: boolean;
  /** In long tasks, shorten older tool results in batches, so the provider's prompt cache keeps working. */
  compactHistory: boolean;
  /** Ask the provider to reuse the unchanged start of each request (Anthropic and OpenAI). */
  promptCaching: boolean;
}

export const DEFAULT_TOKEN_SAVER: TokenSaver = { replies: 'brief', compactOutputs: true, compactHistory: true, promptCaching: true };

export interface AiStateView {
  connections: ConnectionView[];
  routing: Routing;
  budgets: Budgets;
  tokenSaver: TokenSaver;
  vault: VaultStatus;
}

/* ---------------- errors ---------------- */

export type ProviderErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'quota'
  | 'not-found'
  | 'bad-request'
  | 'unsupported'
  | 'server'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'invalid-response'
  | 'not-configured';

export const PROVIDER_ERROR_HELP: Record<ProviderErrorKind, string> = {
  auth: 'The provider rejected the credentials. Check the API key and that it belongs to this provider.',
  'rate-limit': 'The provider is rate-limiting requests. Wait a moment, then try again.',
  quota: 'The account has no remaining quota or credit with this provider.',
  'not-found': 'The endpoint or model was not found. Check the base URL and model identifier.',
  'bad-request': 'The provider refused the request. The model may not support this kind of input.',
  unsupported: 'This model or endpoint does not support the requested capability.',
  server: 'The provider reported a server error. Try again later.',
  network: 'The provider could not be reached. Check the address and your connection.',
  timeout: 'The provider did not respond in time.',
  cancelled: 'The request was cancelled.',
  'invalid-response': 'The provider answered in an unexpected format. This endpoint may not implement the selected protocol.',
  'not-configured': 'No provider is configured for this job yet.',
};

/* ---------------- usage ---------------- */

export interface UsageTotals {
  requests: number;
  /** All input tokens, including those read from or written to the provider's prompt cache. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Input tokens the provider reported as read from its prompt cache (billed at a discount). Null when never reported. */
  cachedInputTokens?: number | null;
  /** Estimated tokens kept out of requests by compacting tool results and older history (characters ÷ 4). */
  savedTokensEstimate?: number;
  /** Estimated cost in USD, or null when any request in the total had unknown pricing or usage. */
  estimatedCostUsd: number | null;
  /** True when the estimate covers only some requests. */
  partial: boolean;
}

export const EMPTY_USAGE: UsageTotals = { requests: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null, savedTokensEstimate: 0, estimatedCostUsd: null, partial: false };

/** Where the tokens of the latest request went, estimated from characters (÷ 4). */
export interface RequestBreakdown {
  instructions: number;
  tools: number;
  conversation: number;
  toolResults: number;
  /** Tokens kept out of this request by compaction (estimated). */
  saved: number;
}

/* ---------------- tasks ---------------- */

export const TASK_MODES = ['ask', 'plan', 'build', 'autopilot'] as const;
/** Modes that edit a task alternative and run tools (Autopilot also needs the project's Autopilot setting). */
export const EDITING_MODES: readonly TaskMode[] = ['build', 'autopilot'];
export type TaskMode = (typeof TASK_MODES)[number];

export const TASK_STATES = ['queued', 'running', 'paused', 'waiting-input', 'cancelling', 'completed', 'failed', 'interrupted', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const ACTIVE_TASK_STATES: readonly TaskState[] = ['queued', 'running', 'paused', 'waiting-input', 'cancelling'];

export interface TaskContext {
  workspace: string;
  lineId: string | null;
  lineName: string | null;
  /** File the user had open, if any. */
  path: string | null;
  /** Selected text, if any (trimmed to a safe length before use). */
  selection: string | null;
  /** Objects the user pointed at (shown as removable chips), identified by stable ids. */
  references?: StudioReference[];
  /** Video playhead when the task was started from the Video workspace. */
  playhead?: { sequenceId: string; seconds: number } | null;
}

/** A selected object the user attached to a task: a file, page element, clip, sequence or asset. */
export interface StudioReference {
  kind: 'file' | 'element' | 'clip' | 'sequence' | 'asset';
  /** Stable id: project path, data-mv-id, clip id, sequence id or asset id. */
  id: string;
  label: string;
  /** Page for elements, sequence id for clips. */
  within?: string | null;
}

/** Per-project AI settings, stored in the project (ai/settings.json). */
export interface ProjectAiSettings {
  /** Lets Autopilot tasks run routine edits, builds, installs and checks without asking. */
  autopilot: boolean;
}

export interface TaskAttachment {
  kind: 'project-file';
  path: string;
  /** Files are only sent to a remote provider when the user included them. */
  bytes: number;
}

export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
}

export interface TaskMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'note';
  text: string;
  toolCalls: ToolCallView[];
  /** `fullChars` is the length before compaction; the full text is kept and can be read again. */
  toolResult: { callId: string; name: string; ok: boolean; output: string; fullChars?: number } | null;
  createdAt: string;
  /** True while an assistant message is still streaming. */
  partial: boolean;
}

export interface TaskStep {
  id: string;
  kind: 'model' | 'tool' | 'command' | 'note';
  title: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'waiting';
  detail: string;
  startedAt: string;
  endedAt: string | null;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  mode: TaskMode;
  job: Job;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  route: { connectionId: string; connectionName: string; modelId: string; local: boolean } | null;
  usage: UsageTotals;
  error: { kind: ProviderErrorKind | 'limit' | 'internal'; message: string } | null;
}

export interface TaskPermissionsView {
  editAlternative: boolean;
  runBuildAndTests: boolean;
  installDependencies: boolean;
  operatePreview: boolean;
}

export interface TaskApproval {
  id: string;
  title: string;
  detail: string;
}

export interface TaskArtifact {
  id: string;
  kind: 'screenshot';
  label: string;
  /** File name inside the project's `ai/artifacts/<task>/` folder. */
  file: string;
  at: string;
}

export interface TaskView extends TaskSummary {
  /** The version the task edits (Build mode creates a task alternative). */
  workingLineId?: string | null;
  workingLineName?: string | null;
  /** The version the user was working on when the task started. */
  originLineId?: string | null;
  permissions?: TaskPermissionsView;
  /** Checkpoint created automatically before a Build or Autopilot task started. */
  checkpointId?: string | null;
  approval?: TaskApproval | null;
  artifacts?: TaskArtifact[];
  context: TaskContext;
  attachments: TaskAttachment[];
  messages: TaskMessage[];
  steps: TaskStep[];
  plan: string[] | null;
  filesChanged: string[];
  result: { summary: string; problems: string[] } | null;
  /** Tool results before this message index are sent in shortened form (moved forward in batches). */
  compactedBefore?: number;
  /** Where the latest request's tokens went (estimated). */
  lastRequest?: RequestBreakdown | null;
}

export type TaskUpdate =
  | { kind: 'delta'; messageId: string; text: string }
  | { kind: 'snapshot'; task: TaskView };
