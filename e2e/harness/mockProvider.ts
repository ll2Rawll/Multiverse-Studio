/**
 * A local, scripted OpenAI-compatible provider for the browser harness and e2e journeys.
 * It is clearly a mock: model ids start with `mock/`, and nothing here is presented as a live
 * provider result. Tool-calling scripts let the coding agent be exercised deterministically.
 */
import http from 'node:http';
import { deflateSync } from 'node:zlib';

/** A small PNG drawn in code (diagonal stripes), so mock "generations" are obviously not real results. */
function mockPng(w = 96, h = 64): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const on = ((x + y) >> 3) % 2 === 0;
      row.set(on ? [240, 160, 60] : [40, 30, 60], 1 + x * 3);
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

export interface MockStep {
  /** Text the model streams. */
  text?: string;
  /** Tool calls the model makes after the text. */
  calls?: { name: string; args: unknown }[];
}

export interface MockProvider {
  url: string;
  /** Queue scripted replies; when empty, the provider echoes a short answer. */
  script(steps: MockStep[]): void;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function startMockProvider(port = 0): Promise<MockProvider> {
  const queue: MockStep[] = [];
  const requests: Record<string, unknown>[] = [];
  let callCounter = 0;
  const deploys = new Map<string, { polls: number; site: string }>();
  const server = http.createServer((req, res) => {
    // Mock Netlify API (same shapes as https://api.netlify.com/api/v1), so publishing can be exercised end to end.
    if (req.url?.startsWith('/netlify/')) {
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== 'Bearer mock-netlify-token') return json(401, { message: 'Access Denied' });
      const p = req.url.slice('/netlify'.length);
      if (req.method === 'POST' && p === '/sites') return json(201, { id: 'mock-site', name: 'mock-kiln', ssl_url: 'https://mock-kiln.netlify.app' });
      const deploy = /^\/sites\/([^/]+)\/deploys$/.exec(p);
      if (req.method === 'POST' && deploy) {
        let size = 0;
        req.on('data', (c: Buffer) => (size += c.length));
        req.on('end', () => {
          const id = `mock-deploy-${deploys.size + 1}`;
          deploys.set(id, { polls: 0, site: deploy[1]! });
          requests.push({ endpoint: 'netlify-deploy', site: deploy[1], bytes: size, contentType: req.headers['content-type'] });
          json(200, { id, state: 'uploaded', admin_url: 'https://app.netlify.com/sites/mock-kiln' });
        });
        return;
      }
      const get = /^\/deploys\/([^/]+)$/.exec(p);
      const d = get ? deploys.get(get[1]!) : undefined;
      if (req.method === 'GET' && get && d) {
        d.polls += 1;
        if (d.polls < 2) return json(200, { id: get[1], state: 'processing' });
        return json(200, { id: get[1], state: 'ready', ssl_url: 'https://mock-kiln.netlify.app', deploy_ssl_url: `https://${get[1]}--mock-kiln.netlify.app`, admin_url: 'https://app.netlify.com/sites/mock-kiln' });
      }
      return json(404, { message: 'Not Found' });
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock/assistant', object: 'model' }, { id: 'mock/coder', object: 'model' }, { id: 'mock/image', object: 'model' }, { id: 'mock/whisper', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ endpoint: 'images', ...(JSON.parse(body) as object) });
        const n = Math.max(1, Math.min(4, Number((JSON.parse(body) as { n?: number }).n ?? 1)));
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': `mock-img-${requests.length}` });
        res.end(JSON.stringify({ data: Array.from({ length: n }, () => ({ b64_json: mockPng().toString('base64') })), output_format: 'png', usage: { input_tokens: 9, output_tokens: 0 } }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      let size = 0;
      req.on('data', (c: Buffer) => (size += c.length));
      req.on('end', () => {
        requests.push({ endpoint: 'transcriptions', bytes: size });
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': `mock-tr-${requests.length}` });
        res.end(JSON.stringify({ text: 'Mock transcript. Second mock line.', language: 'english', duration: 4, segments: [{ start: 0.2, end: 1.6, text: ' Mock transcript.' }, { start: 2.0, end: 3.6, text: ' Second mock line.' }] }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages?: { role: string; content: unknown }[] };
        requests.push(parsed);
        const step = queue.shift() ?? { text: `Mock answer to: ${String(parsed.messages?.filter((m) => m.role === 'user').pop()?.content ?? '').slice(0, 80)}` };
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const send = (o: unknown): boolean => res.write(`data: ${JSON.stringify(o)}\n\n`);
        const words = (step.text ?? '').split(/(?<=\s)/);
        let i = 0;
        const tick = (): void => {
          if (i < words.length) {
            send({ choices: [{ index: 0, delta: { content: words[i++] } }] });
            setTimeout(tick, 8);
            return;
          }
          (step.calls ?? []).forEach((c, index) => {
            callCounter += 1;
            send({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_mock_${callCounter}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] });
          });
          send({ choices: [{ index: 0, delta: {}, finish_reason: step.calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 40 } });
          res.end('data: [DONE]\n\n');
        };
        tick();
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    script: (steps) => queue.push(...steps),
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
