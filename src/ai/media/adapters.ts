/**
 * Media adapters, written against the providers' current documentation (read Nov 2026):
 *
 * - OpenAI Images API: POST /images/generations with a GPT Image model; results are always
 *   base64 (`data[].b64_json`), sizes are WIDTHxHEIGHT (multiples of 16 on gpt-image-2+).
 * - OpenAI audio transcriptions: POST /audio/transcriptions (multipart). Segment timings need
 *   `response_format=verbose_json` + `timestamp_granularities[]=segment` (whisper-1, gpt-transcribe,
 *   and OpenAI-compatible local servers); `gpt-4o-transcribe-diarize` returns `diarized_json`
 *   segments; `gpt-4o(-mini)-transcribe` return text only, which cannot become timed captions.
 * - Gemini Interactions API (POST /interactions): images (`response_format.type = image`),
 *   speech (`type = audio`, voice in `generation_config.speech_config`), and video with Gemini
 *   Omni Flash (`type = video`, `delivery = uri`). Video runs as a background interaction whose
 *   id is kept; it is polled with GET /interactions/{id} and cancelled with
 *   POST /interactions/{id}/cancel. Hosted results are files polled until ACTIVE, then downloaded.
 *
 * Model ids are never hardcoded here: they come from the user's routing (Settings → Models).
 */
import { ProviderError } from '../errors';
import { providerFetch } from '../http';
import type { AdapterContext } from '../types';
import type { TranscriptSegment } from '../../shared/media';
import { abortableSleep } from '../../shared/sleep';

export interface MediaBytes {
  bytes: Buffer;
  mime: string;
  ext: string;
}

const extFor = (mime: string): string =>
  ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg' })[mime] ?? 'bin';

/* ---------------- OpenAI Images ---------------- */

export async function openaiGenerateImages(
  ctx: AdapterContext,
  req: { model: string; prompt: string; size: string; quality: string; count: number },
): Promise<{ images: MediaBytes[]; requestId: string | null; usage: { inputTokens: number | null; outputTokens: number | null } }> {
  const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, n: req.count, output_format: 'png' };
  if (req.size && req.size !== 'auto') body.size = req.size;
  if (req.quality && req.quality !== 'auto') body.quality = req.quality;
  const res = await providerFetch(ctx, '/images/generations', { body, timeoutMs: Math.max(ctx.config.timeoutMs, 300_000) });
  const json = (await res.json().catch(() => null)) as { data?: { b64_json?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; output_format?: string } | null;
  const items = json?.data?.filter((d) => typeof d.b64_json === 'string') ?? [];
  if (!items.length) throw new ProviderError('invalid-response', 'The Images API answered without any image data.');
  const mime = json?.output_format === 'jpeg' ? 'image/jpeg' : json?.output_format === 'webp' ? 'image/webp' : 'image/png';
  return {
    images: items.map((d) => ({ bytes: Buffer.from(d.b64_json!, 'base64'), mime, ext: extFor(mime) })),
    requestId: res.headers.get('x-request-id'),
    usage: { inputTokens: json?.usage?.input_tokens ?? null, outputTokens: json?.usage?.output_tokens ?? null },
  };
}

/* ---------------- OpenAI transcription ---------------- */

/** Which response format gives timed segments for a model, or null if it only returns text. */
export function transcriptionFormat(model: string): 'verbose_json' | 'diarized_json' | null {
  if (/diarize/.test(model)) return 'diarized_json';
  if (/^(openai\/)?gpt-4o(-mini)?-transcribe(-\d{4}-\d{2}-\d{2})?$/.test(model)) return null;
  return 'verbose_json';
}

export async function openaiTranscribe(
  ctx: AdapterContext,
  req: { model: string; file: Buffer; filename: string; mime: string; language: string | null },
): Promise<{ segments: TranscriptSegment[]; language: string | null; text: string; duration: number | null; requestId: string | null; usage: { seconds: number | null; inputTokens: number | null; outputTokens: number | null } }> {
  const format = transcriptionFormat(req.model);
  if (!format) {
    throw new ProviderError('unsupported', `${req.model} returns text without timings, so it can't make captions. Assign a model that returns segments (for example whisper-1, gpt-transcribe or a diarize model) to Transcription in Settings → Models.`);
  }
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(req.file)], { type: req.mime }), req.filename);
  form.append('model', req.model);
  form.append('response_format', format);
  if (format === 'verbose_json') form.append('timestamp_granularities[]', 'segment');
  if (format === 'diarized_json') form.append('chunking_strategy', 'auto');
  if (req.language) form.append('language', req.language);
  const res = await providerFetch(ctx, '/audio/transcriptions', { raw: form, timeoutMs: Math.max(ctx.config.timeoutMs, 600_000) });
  const json = (await res.json().catch(() => null)) as {
    text?: string;
    language?: string;
    duration?: number;
    segments?: { start?: number; end?: number; text?: string; speaker?: string }[];
    usage?: { type?: string; seconds?: number; input_tokens?: number; output_tokens?: number };
  } | null;
  if (!json || !Array.isArray(json.segments)) throw new ProviderError('invalid-response', 'The transcription came back without timed segments.');
  const segments: TranscriptSegment[] = json.segments
    .filter((s) => typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string')
    .map((s) => ({ start: s.start!, end: s.end!, text: s.text!.trim(), speaker: s.speaker ?? null }))
    .filter((s) => s.text && s.end > s.start);
  return {
    segments,
    language: json.language ?? null,
    text: json.text ?? segments.map((s) => s.text).join(' '),
    duration: typeof json.duration === 'number' ? json.duration : null,
    requestId: res.headers.get('x-request-id'),
    usage: { seconds: json.usage?.seconds ?? null, inputTokens: json.usage?.input_tokens ?? null, outputTokens: json.usage?.output_tokens ?? null },
  };
}

/* ---------------- Gemini Interactions ---------------- */

interface InteractionContent {
  type?: string;
  data?: string;
  uri?: string;
  mime_type?: string;
  text?: string;
}
export interface Interaction {
  id?: string;
  status?: string;
  steps?: { type?: string; content?: InteractionContent[] }[];
  outputs?: InteractionContent[];
  error?: { message?: string; code?: number | string };
  usage?: { total_input_tokens?: number; total_output_tokens?: number };
}

/** Media blocks from an interaction's model output (newer `steps`, or the older `outputs`). */
export function interactionMedia(i: Interaction, type: 'image' | 'audio' | 'video'): InteractionContent[] {
  const fromSteps = (i.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? []);
  return [...fromSteps, ...(i.outputs ?? [])].filter((c) => c.type === type && (c.data || c.uri));
}

export function interactionText(i: Interaction): string {
  const fromSteps = (i.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? []);
  return [...fromSteps, ...(i.outputs ?? [])]
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n')
    .trim();
}

async function readInteraction(res: Response): Promise<Interaction> {
  const json = (await res.json().catch(() => null)) as Interaction | null;
  if (!json || typeof json !== 'object') throw new ProviderError('invalid-response', 'The Interactions API answered with something that is not an interaction.');
  return json;
}

/** Download inline or hosted media. Hosted files are polled until ACTIVE first. Our key is only sent to the provider's own host. */
export async function geminiMediaBytes(ctx: AdapterContext, c: InteractionContent, fallbackMime: string): Promise<MediaBytes> {
  const mime = c.mime_type ?? fallbackMime;
  if (c.data) return { bytes: Buffer.from(c.data, 'base64'), mime, ext: extFor(mime) };
  const uri = c.uri!;
  const base = new URL(ctx.config.baseUrl);
  const target = new URL(uri);
  const sameHost = target.host === base.host;
  const fileId = /\/files\/([^/:?]+)/.exec(target.pathname)?.[1];
  if (sameHost && fileId) {
    for (let i = 0; i < 120; i++) {
      const meta = (await (await providerFetch(ctx, `/files/${fileId}`)).json().catch(() => null)) as { state?: string; error?: { message?: string } } | null;
      if (!meta?.state || meta.state === 'ACTIVE') break;
      if (meta.state === 'FAILED') throw new ProviderError('invalid-response', `The provider could not prepare the generated file${meta.error?.message ? `: ${meta.error.message}` : '.'}`);
      await sleep(2000, ctx.signal);
    }
  }
  const res = sameHost ? await providerFetch(ctx, uri, { timeoutMs: 600_000 }) : await ctx.fetch(uri, { signal: ctx.signal });
  if (!res.ok) throw new ProviderError('network', `Downloading the result failed (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mime: res.headers.get('content-type')?.split(';')[0] || mime, ext: extFor(mime) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return abortableSleep(ms, signal, () => new ProviderError('cancelled', 'Stopped waiting.'));
}

export async function geminiGenerateImages(
  ctx: AdapterContext,
  req: { model: string; prompt: string; aspectRatio: string; imageSize: string | null },
): Promise<{ images: MediaBytes[]; text: string; requestId: string | null; usage: { inputTokens: number | null; outputTokens: number | null } }> {
  const response_format: Record<string, unknown> = { type: 'image' };
  if (req.aspectRatio) response_format.aspect_ratio = req.aspectRatio;
  if (req.imageSize) response_format.image_size = req.imageSize;
  const res = await providerFetch(ctx, '/interactions', { body: { model: req.model, input: [{ type: 'text', text: req.prompt }], response_format }, timeoutMs: Math.max(ctx.config.timeoutMs, 300_000) });
  const i = await readInteraction(res);
  if (i.status && i.status !== 'completed') throw new ProviderError('invalid-response', `The image request ended as “${i.status}”${i.error?.message ? `: ${i.error.message}` : '.'}`);
  const blocks = interactionMedia(i, 'image');
  if (!blocks.length) throw new ProviderError('invalid-response', `The model answered without an image.${interactionText(i) ? ` It said: ${interactionText(i).slice(0, 300)}` : ''}`);
  const images: MediaBytes[] = [];
  for (const b of blocks) images.push(await geminiMediaBytes(ctx, b, 'image/png'));
  return { images, text: interactionText(i), requestId: i.id ?? null, usage: { inputTokens: i.usage?.total_input_tokens ?? null, outputTokens: i.usage?.total_output_tokens ?? null } };
}

export async function geminiSpeech(ctx: AdapterContext, req: { model: string; text: string; voice: string; style: string }): Promise<{ audio: MediaBytes; requestId: string | null }> {
  const content: Record<string, unknown> = { type: 'text', text: req.text };
  if (req.style.trim()) content.annotations = [{ type: 'speech_metadata', style: req.style.trim() }];
  const body = {
    model: req.model,
    input: [{ type: 'user_input', content: [content] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: req.voice || 'Kore' }] },
  };
  const res = await providerFetch(ctx, '/interactions', { body, timeoutMs: Math.max(ctx.config.timeoutMs, 300_000) });
  const i = await readInteraction(res);
  const block = interactionMedia(i, 'audio')[0];
  if (!block) throw new ProviderError('invalid-response', 'The model answered without audio.');
  return { audio: await geminiMediaBytes(ctx, block, 'audio/wav'), requestId: i.id ?? null };
}

/** Start a background video interaction. Returns its id as soon as the provider has one. */
export async function geminiVideoSubmit(
  ctx: AdapterContext,
  req: { model: string; prompt: string; aspectRatio: string; resolution: string; image: { data: Buffer; mime: string } | null },
): Promise<Interaction> {
  const input: Record<string, unknown>[] = [{ type: 'text', text: req.prompt }];
  if (req.image) input.push({ type: 'image', data: req.image.data.toString('base64'), mime_type: req.image.mime });
  const body = {
    model: req.model,
    input,
    response_format: { type: 'video', aspect_ratio: req.aspectRatio, resolution: req.resolution, delivery: 'uri' },
    background: true,
  };
  const res = await providerFetch(ctx, '/interactions', { body, timeoutMs: Math.max(ctx.config.timeoutMs, 900_000) });
  const i = await readInteraction(res);
  if (!i.id && i.status !== 'completed') throw new ProviderError('invalid-response', 'The provider accepted the request but returned no interaction id to follow.');
  return i;
}

export async function geminiInteraction(ctx: AdapterContext, id: string): Promise<Interaction> {
  return readInteraction(await providerFetch(ctx, `/interactions/${encodeURIComponent(id)}`));
}

export async function geminiCancelInteraction(ctx: AdapterContext, id: string): Promise<void> {
  await providerFetch(ctx, `/interactions/${encodeURIComponent(id)}/cancel`, { method: 'POST', raw: '' });
}
