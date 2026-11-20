/**
 * The MCP endpoint's JSON-RPC handling, for both eras of the protocol:
 * - modern (2026-07-28): every request carries its version, client info and capabilities in
 *   `_meta`, mirrored into MCP-Protocol-Version / Mcp-Method / Mcp-Name headers, which must match;
 * - legacy (2025-03-26 … 2025-11-25): an `initialize` handshake, then plain requests.
 * Stateless either way: no session ids are minted. Tool failures are results with isError; only
 * protocol problems are JSON-RPC errors.
 */
import { CONNECTOR_PROTOCOL_VERSIONS } from '../shared/connector';

export const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS = CONNECTOR_PROTOCOL_VERSIONS.filter((v) => v !== MODERN_VERSION);
const META = 'io.modelcontextprotocol';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolOutput {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpTool<C> {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(args: Record<string, unknown>, ctx: C): Promise<ToolOutput>;
}

export interface McpServerInfo {
  name: string;
  title: string;
  version: string;
  instructions: string;
}

export interface McpHttpResponse {
  status: number;
  body?: unknown;
}

interface Rpc {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
}

const err = (id: Rpc['id'], code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });

/** Header values may use the =?base64?…?= sentinel (non-ASCII tool names, padded values). */
export function decodeHeaderValue(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : v;
}

export async function handleMcpRequest<C>(headers: Record<string, string | undefined>, body: unknown, tools: McpTool<C>[], info: McpServerInfo, ctx: C, signal: AbortSignal): Promise<McpHttpResponse> {
  if (Array.isArray(body)) return { status: 400, body: err(null, -32600, 'Batches are not supported; send one JSON-RPC message per request.') };
  if (!body || typeof body !== 'object') return { status: 400, body: err(null, -32700, 'The body must be a JSON-RPC message.') };
  const rpc = body as Rpc;
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    // A response sent by a client is not something this server ever asks for.
    return { status: 400, body: err(rpc.id, -32600, 'Expected a JSON-RPC 2.0 request or notification.') };
  }
  const method = rpc.method;
  const isNotification = rpc.id === undefined;
  if (isNotification) return { status: 202 };
  const meta = rpc.params?._meta ?? {};
  const modernVersion = meta[`${META}/protocolVersion`];
  const header = (n: string) => headers[n.toLowerCase()];

  if (typeof modernVersion === 'string') {
    // Modern era: validate mirrored headers, then the version.
    const hv = header('mcp-protocol-version');
    const hm = header('mcp-method');
    const mismatch =
      hv === undefined || hm === undefined
        ? 'A required header (MCP-Protocol-Version, Mcp-Method) is missing.'
        : hv !== modernVersion
          ? `MCP-Protocol-Version header ${hv} does not match the body’s ${modernVersion}.`
          : hm !== method
            ? `Mcp-Method header ${hm} does not match the body’s ${method}.`
            : method === 'tools/call' && decodeHeaderValue(header('mcp-name')) !== rpc.params?.name
              ? 'Mcp-Name header does not match params.name.'
              : null;
    if (mismatch) return { status: 400, body: err(rpc.id, -32020, `Header mismatch: ${mismatch}`) };
    if (modernVersion !== MODERN_VERSION) return { status: 400, body: err(rpc.id, -32022, 'Unsupported protocol version', { supported: [...CONNECTOR_PROTOCOL_VERSIONS], requested: modernVersion }) };
    const done = (result: Record<string, unknown>): McpHttpResponse => ({ status: 200, body: ok(rpc.id, { resultType: 'complete', ...result }) });
    switch (method) {
      case 'server/discover':
        return done({ supportedVersions: [...CONNECTOR_PROTOCOL_VERSIONS], capabilities: { tools: {} }, _meta: { [`${META}/serverInfo`]: { name: info.name, title: info.title, version: info.version } }, instructions: info.instructions });
      case 'ping':
        return done({});
      case 'tools/list':
        return done({ tools: tools.map(describe) });
      case 'tools/call':
        return callTool(rpc, tools, ctx, signal, done);
      default:
        return { status: 404, body: err(rpc.id, -32601, `Method not found: ${method}`) };
    }
  }

  // Legacy era.
  const hv = header('mcp-protocol-version');
  if (hv !== undefined && !(LEGACY_VERSIONS as readonly string[]).includes(hv)) {
    return { status: 400, body: err(rpc.id, -32600, `Unsupported MCP-Protocol-Version ${hv}. Supported: ${CONNECTOR_PROTOCOL_VERSIONS.join(', ')}.`) };
  }
  const done = (result: Record<string, unknown>): McpHttpResponse => ({ status: 200, body: ok(rpc.id, result) });
  switch (method) {
    case 'initialize': {
      const requested = typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : '';
      const version = (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0]!;
      return done({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: info.name, title: info.title, version: info.version }, instructions: info.instructions });
    }
    case 'ping':
      return done({});
    case 'tools/list':
      return done({ tools: tools.map(describe) });
    case 'tools/call':
      return callTool(rpc, tools, ctx, signal, done);
    default:
      return { status: 200, body: err(rpc.id, -32601, `Method not found: ${method}`) };
  }
}

function describe<C>(t: McpTool<C>) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } };
}

async function callTool<C>(rpc: Rpc, tools: McpTool<C>[], ctx: C, signal: AbortSignal, done: (r: Record<string, unknown>) => McpHttpResponse): Promise<McpHttpResponse> {
  const name = rpc.params?.name;
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { status: 200, body: err(rpc.id, -32602, `Unknown tool: ${String(name)}`) };
  const args = rpc.params?.arguments;
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) return { status: 200, body: err(rpc.id, -32602, 'arguments must be an object') };
  try {
    const out = await tool.run((args ?? {}) as Record<string, unknown>, ctx);
    if (signal.aborted) return { status: 499 };
    return done({ content: out.content, ...(out.structuredContent ? { structuredContent: out.structuredContent } : {}), isError: out.isError ?? false });
  } catch (error) {
    // Execution errors go back to the model so it can correct itself.
    return done({ content: [{ type: 'text', text: (error as Error).message || String(error) }], isError: true });
  }
}
