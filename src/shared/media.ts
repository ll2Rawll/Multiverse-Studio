/**
 * AI media jobs (image, video and speech generation, transcription) and preview recordings.
 * Every job is a persisted state machine; provider job ids are kept so long-running remote jobs
 * can be checked after a restart. Nothing is ever resubmitted automatically.
 */

export const MEDIA_JOB_KINDS = ['image', 'video', 'speech', 'transcription', 'recording'] as const;
export type MediaJobKind = (typeof MEDIA_JOB_KINDS)[number];

export type MediaJobState =
  /** Saved, not sent yet. */
  | 'queued'
  /** The request is being sent; whether the provider accepted it is not known yet. */
  | 'submitting'
  /** The provider accepted it (or a local process is running). */
  | 'running'
  | 'downloading'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** A local step (or a request that was never sent) stopped when the app closed. Safe to retry. */
  | 'interrupted'
  /** The app closed while a paid request was in flight and the provider gave no job id to check. */
  | 'uncertain';

export interface MediaProvenance {
  source: 'imported' | 'generated' | 'recording';
  provider: string | null;
  connectionName: string | null;
  model: string | null;
  prompt: string | null;
  settings: Record<string, string | number | boolean | null>;
  createdAt: string;
  /** The provider's id for the request or job, when it returned one. */
  requestId: string | null;
  jobId: string | null;
}

export interface MediaJobUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Seconds of audio processed or video generated, when reported. */
  seconds: number | null;
  /** Estimated cost in USD; null when the provider's price is unknown. Always labelled as an estimate. */
  estimatedUsd: number | null;
}

export interface MediaJobView {
  id: string;
  projectId: string;
  kind: MediaJobKind;
  state: MediaJobState;
  /** One line describing what is happening now. */
  detail: string;
  title: string;
  prompt: string | null;
  settings: Record<string, string | number | boolean | null>;
  connectionId: string | null;
  connectionName: string | null;
  provider: string | null;
  model: string | null;
  /** The provider's job or request id, kept so the job can be checked after a restart. */
  remoteId: string | null;
  /** What was sent to the provider (names and sizes, never content). */
  sent: { name: string; bytes: number }[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Assets created from the result. */
  assetIds: string[];
  /** For transcription jobs: the asset that was transcribed. */
  sourceAssetId: string | null;
  usage: MediaJobUsage;
  /** Whether stopping this job also stops the provider's work (true), or only stops waiting (false). */
  remoteCancel: boolean;
  /** Set when the user explicitly retried a failed/uncertain job; the new job's id. */
  retriedAs: string | null;
  retryOf: string | null;
}

export interface TranscriptSegment {
  /** Seconds in the source media. */
  start: number;
  end: number;
  text: string;
  speaker: string | null;
}

export interface TranscriptView {
  assetId: string;
  jobId: string;
  language: string | null;
  model: string | null;
  createdAt: string;
  segments: TranscriptSegment[];
}

export interface ImageRequest {
  prompt: string;
  /** e.g. 1536x1024 (OpenAI) or an aspect ratio such as 16:9 (Gemini). */
  size: string;
  quality: 'auto' | 'low' | 'medium' | 'high';
  count: number;
}

export interface VideoRequest {
  prompt: string;
  aspectRatio: '16:9' | '9:16';
  resolution: '360p' | '720p' | '1080p';
  /** Optional still to animate (image-to-video): an image asset id. */
  imageAssetId: string | null;
}

export interface SpeechRequest {
  text: string;
  voice: string;
  style: string;
}

export interface TranscriptionRequest {
  assetId: string;
  language: string | null;
}

/** What a job will send, shown before anything leaves the computer. */
export interface MediaJobPlan {
  kind: MediaJobKind;
  connectionName: string;
  provider: string;
  model: string;
  local: boolean;
  sends: { name: string; bytes: number | null; note: string }[];
  /** Estimated cost in USD, or null when unknown. */
  estimatedUsd: number | null;
  notes: string[];
}

/* ---------------- preview recording ---------------- */

export type RecordStep =
  | { kind: 'wait'; ms: number }
  | { kind: 'scroll'; y: number; ms: number }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'hover'; selector: string };

export interface RecordingRequest {
  lineId: string;
  /** A page of the version's preview (e.g. index.html), or 'dev-server' to record the running app. */
  page: string;
  width: number;
  height: number;
  /** Total length; scripted steps run inside it, and the rest is waiting. */
  seconds: number;
  steps: RecordStep[];
}

/* ---------------- asset links (shared media) ---------------- */

/** A copy of a library asset placed in a version (for example an image in a website). */
export interface AssetLinkView {
  lineId: string;
  lineName: string;
  path: string;
  assetId: string;
  /** The asset content the copy was made from; differs from the asset's current content when outdated. */
  sha256: string;
  outdated: boolean;
}

/** Where an asset is used across the project's versions. */
export interface AssetUsageView {
  assetId: string;
  sequences: { lineId: string; lineName: string; sequenceId: string; sequenceName: string; clips: number }[];
  files: AssetLinkView[];
  brand: string[];
}

/* ---------------- AI timeline edits ---------------- */

export const TIMELINE_OPS = ['remove-pauses', 'captions', 'duck', 'trim', 'portrait'] as const;
export type TimelineOp = (typeof TIMELINE_OPS)[number];

export interface TimelineProposalView {
  id: string;
  sequenceId: string;
  sequenceName: string;
  instruction: string;
  summary: string;
  /** One line per validated operation. */
  steps: string[];
  warnings: string[];
  before: { seconds: number; clips: number };
  after: { seconds: number; clips: number };
  /** Names of sequences the edit creates (for example a portrait version). */
  newSequences: string[];
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  /** What was sent to a model (descriptions only); empty for local analysis. */
  sent: string[];
}

/* ---------------- brand ---------------- */

export interface BrandSettingsView {
  colors: { id: string; name: string; value: string }[];
  fonts: { id: string; name: string; family: string; assetId: string | null }[];
  textStyles: { id: string; name: string; fontId: string | null; size: number; weight: number; lineHeight: number; colorId: string | null }[];
  logoAssetId: string | null;
}

export interface BrandPlanItemView {
  id: string;
  lineId: string;
  lineName: string;
  kind: 'website-theme' | 'video-titles';
  target: string;
  changes: string[];
  fontFiles: { path: string; assetId: string }[];
}

export interface BrandPlanView {
  items: BrandPlanItemView[];
  notes: string[];
}

/* ---------------- timelines across versions ---------------- */

export interface TimelineConflictItemView {
  key: string;
  kind: 'settings' | 'track' | 'track-delete' | 'clip' | 'clip-delete' | 'overlap';
  label: string;
  ours: string;
  theirs: string;
  allowBoth: boolean;
  range: [number, number] | null;
}

export interface SequenceDiffView {
  name: [string, string];
  settings: { field: string; left: string; right: string }[];
  tracks: { id: string; name: string; status: 'added' | 'deleted' | 'changed' | 'same'; kind: 'video' | 'audio' | 'text' }[];
  clips: { id: string; label: string; trackName: string; status: 'added' | 'deleted' | 'moved' | 'trimmed' | 'changed'; left: [number, number] | null; right: [number, number] | null }[];
  duration: [number, number];
}
