/**
 * Streaming parsers for Server-Sent Events (OpenAI, Anthropic, Gemini `alt=sse`, OpenRouter) and
 * newline-delimited JSON (Ollama). Both are tolerant of chunk boundaries anywhere in the stream.
 */

export interface SseEvent {
  event: string | null;
  data: string;
  id: string | null;
}

async function* textChunks(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const iterable: AsyncIterable<Uint8Array> =
    body instanceof ReadableStream ? readerIterable(body, signal) : (body as AsyncIterable<Uint8Array>);
  for await (const chunk of iterable) {
    if (signal?.aborted) return;
    yield decoder.decode(chunk, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Read a stream, cancelling the pending read as soon as the signal aborts. */
async function* readerIterable(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export async function* parseSse(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  let buffer = '';
  let event: string | null = null;
  let id: string | null = null;
  let data: string[] = [];
  const flush = (): SseEvent | null => {
    if (data.length === 0) {
      event = null;
      return null;
    }
    const out = { event, data: data.join('\n'), id };
    event = null;
    data = [];
    return out;
  };
  for await (const text of textChunks(body, signal)) {
    buffer += text;
    let newline: number;
    while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + (buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1));
      if (line === '') {
        const ev = flush();
        if (ev) yield ev;
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive (OpenRouter sends these)
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id') id = value;
    }
  }
  if (buffer.length > 0 && buffer.startsWith('data')) data.push(buffer.replace(/^data:\s?/, ''));
  const last = flush();
  if (last) yield last;
}

export async function* parseNdjson(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  let buffer = '';
  for await (const text of textChunks(body, signal)) {
    buffer += text;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer.trim());
}
