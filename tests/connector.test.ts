/**
 * Connect AI apps: the MCP endpoint (modern and legacy protocol eras), OAuth for remote apps with
 * approval in the studio, the local bridge for Claude Desktop, the .mcpb extension, the tunnel,
 * and the commands an app can run (undoable, logged under its name, risky ones asking here).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import readline from 'node:readline';
import type { AddressInfo } from 'node:net';
import JSZip from 'jszip';
import { StudioService } from '../src/services/studio';
import { handleMcpRequest, type McpTool } from '../src/connector/protocol';
import { buildExtension } from '../src/connector/extension';
import { PlaywrightProbe } from '../e2e/harness/playwrightProbe';
import { SHARED_LINE_ID, type StudioEvent } from '../src/shared/types';
import { tempDir } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLE_ROOT = path.join(ROOT, 'sample');
const PUBLIC = 'https://studio.example.test';
const probe = new PlaywrightProbe();
after(() => probe.close());

const echo: McpTool<null> = { name: 'echo', title: 'Echo', description: 'Echo', inputSchema: { type: 'object', properties: { t: { type: 'string' } } }, annotations: { readOnlyHint: true }, run: async (a) => ({ content: [{ type: 'text', text: String(a.t) }] }) };
const info = { name: 'mv', title: 'MV', version: '1', instructions: 'Use it.' };
const modernMeta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'T', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const H = (method: string, name?: string) => ({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) });

test('protocol: the modern era checks mirrored headers and versions; the legacy era negotiates with initialize', async () => {
  const s = new AbortController().signal;
  const call = (headers: Record<string, string>, body: unknown) => handleMcpRequest(headers, body, [echo], info, null, s);
  let r = await call(H('server/discover'), { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta } });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { result: { supportedVersions: string[] } }).result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
  r = await call(H('tools/call', 'echo'), { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { t: 'hi' }, _meta: modernMeta } });
  assert.deepEqual((r.body as { result: unknown }).result, { resultType: 'complete', content: [{ type: 'text', text: 'hi' }], isError: false });
  r = await call(H('tools/call', `=?base64?${Buffer.from('echo').toString('base64')}?=`), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { t: 'b64' }, _meta: modernMeta } });
  assert.equal(r.status, 200, 'base64-encoded Mcp-Name is decoded before comparing');
  r = await call(H('tools/call', 'other'), { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', _meta: modernMeta } });
  assert.deepEqual([r.status, (r.body as { error: { code: number } }).error.code], [400, -32020]);
  r = await call({}, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: modernMeta } });
  assert.deepEqual([r.status, (r.body as { error: { code: number } }).error.code], [400, -32020], 'missing headers');
  r = await call({ ...H('tools/list'), 'mcp-protocol-version': '2099-01-01' }, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { _meta: { ...modernMeta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } });
  assert.deepEqual([r.status, (r.body as { error: { code: number; data: { requested: string } } }).error.code, (r.body as { error: { data: { requested: string } } }).error.data.requested], [400, -32022, '2099-01-01']);
  r = await call(H('nope/nope'), { jsonrpc: '2.0', id: 7, method: 'nope/nope', params: { _meta: modernMeta } });
  assert.deepEqual([r.status, (r.body as { error: { code: number } }).error.code], [404, -32601]);
  // Legacy
  r = await call({}, { jsonrpc: '2.0', id: 8, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ChatGPT', version: '1' } } });
  assert.equal((r.body as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');
  r = await call({}, { jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal((r.body as { result: { protocolVersion: string } }).result.protocolVersion, '2025-11-25', 'an unknown legacy version gets the newest legacy one');
  assert.equal((await call({ 'mcp-protocol-version': '2025-06-18' }, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  r = await call({ 'mcp-protocol-version': '2025-06-18' }, { jsonrpc: '2.0', id: 10, method: 'tools/list' });
  assert.equal((r.body as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }).result.tools[0]!.annotations.readOnlyHint, true);
  assert.equal((await call({}, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status, 400, 'no batches');
});

/** A raw HTTP request to the connector with any Host header (fetch cannot set Host). */
function req(port: number, method: string, p: string, opts: { host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: opts.host ?? new URL(PUBLIC).host, ...(opts.body !== undefined ? { 'content-length': Buffer.byteLength(opts.body) } : {}), ...opts.headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    r.on('error', reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

async function setup() {
  const { dir, cleanup } = await tempDir('mv-connector-');
  const events: StudioEvent[] = [];
  let service!: StudioService;
  const previews = http.createServer(async (rq, rs) => {
    const host = (rq.headers.host ?? '').split(':')[0] ?? '';
    const reply = await service.servePreview(host.split('.')[0] ?? '', new URL(rq.url ?? '/', 'http://x').pathname, `http://${rq.headers.host}`);
    rs.writeHead(reply.status, reply.headers);
    rs.end(reply.body);
  });
  await new Promise<void>((r) => previews.listen(0, '127.0.0.1', r));
  const pport = (previews.address() as AddressInfo).port;
  const home = path.join(dir, 'home');
  service = new StudioService({
    workspaceRoot: path.join(dir, 'ws'),
    sampleRoot: SAMPLE_ROOT,
    previewUrl: (t) => `http://${t}.localhost:${pport}/`,
    emit: (e) => events.push(e),
    cacheRoot: path.join(dir, 'cache'),
    agent: { cacheRoot: path.join(dir, 'cache'), probe },
    connector: { root: path.join(dir, 'connector'), home, port: 0 },
  });
  await service.connector!.init();
  const state = await service.call('connector.setEnabled', { enabled: true });
  const port = Number(new URL(state.localUrl!).port);
  return { service, events, port, home, dir, cleanup: async () => { await service.shutdown(); previews.close(); await cleanup(); } };
}

const waitFor = async <T>(fn: () => Promise<T | null | undefined> | T | null | undefined, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Connect as ChatGPT would: register, authorize (approved in the studio), exchange the code. */
async function connectRemote(h: Awaited<ReturnType<typeof setup>>, name = 'ChatGPT') {
  const reg = await req(h.port, 'POST', '/register', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }) });
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.json().client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${PUBLIC}/mcp`, scope: 'studio' });
  const start = await req(h.port, 'GET', `/authorize?${q}`);
  assert.equal(start.status, 303);
  const wait = start.headers.location!;
  const waiting = await req(h.port, 'GET', wait);
  assert.match(waiting.text, /Approve in Multiverse Studio/);
  assert.match(String(waiting.headers['content-security-policy']), /frame-ancestors 'none'/);
  const pending = await waitFor(async () => (await h.service.call('connector.state', {})).pending.find((p) => p.kind === 'connect'));
  assert.equal(pending.appName, name);
  assert.equal(pending.redirectHost, 'chatgpt.com');
  await h.service.call('connector.decide', { id: pending.id, allow: true });
  const back = await waitFor(async () => {
    const r = await req(h.port, 'GET', wait);
    return r.status === 302 ? r : null;
  });
  const redirect = new URL(back.headers.location!);
  assert.equal(redirect.origin + redirect.pathname, 'https://chatgpt.com/connector_platform_oauth_redirect');
  assert.equal(redirect.searchParams.get('state'), 'xyz');
  const code = redirect.searchParams.get('code')!;
  const form = (p: Record<string, string>) => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p).toString() });
  const bad = await req(h.port, 'POST', '/token', form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_verifier: randomBytes(32).toString('base64url'), resource: `${PUBLIC}/mcp` }));
  assert.deepEqual([bad.status, bad.json().error], [400, 'invalid_grant'], 'a wrong PKCE verifier fails (and uses up the code)');
  return { clientId, verifier, challenge, form };
}

async function token(h: Awaited<ReturnType<typeof setup>>, name = 'ChatGPT') {
  // A second, clean authorization (the first code was spent on the wrong verifier).
  const c = await connectRemote(h, name);
  const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_challenge: c.challenge, code_challenge_method: 'S256', resource: `${PUBLIC}/mcp` });
  const wait = (await req(h.port, 'GET', `/authorize?${q}`)).headers.location!;
  const pending = await waitFor(async () => (await h.service.call('connector.state', {})).pending.find((p) => p.kind === 'connect'));
  await h.service.call('connector.decide', { id: pending.id, allow: true });
  const code = new URL((await waitFor(async () => { const r = await req(h.port, 'GET', wait); return r.status === 302 ? r : null; })).headers.location!).searchParams.get('code')!;
  const t = await req(h.port, 'POST', '/token', c.form({ grant_type: 'authorization_code', code, client_id: c.clientId, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_verifier: c.verifier, resource: `${PUBLIC}/mcp` }));
  assert.equal(t.status, 200, t.text);
  const reuse = await req(h.port, 'POST', '/token', c.form({ grant_type: 'authorization_code', code, client_id: c.clientId, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_verifier: c.verifier }));
  assert.equal(reuse.json().error, 'invalid_grant', 'codes are single use');
  return { ...c, access: t.json().access_token as string, refresh: t.json().refresh_token as string };
}

test('remote apps: OAuth discovery, approval in the studio, PKCE, audience-bound tokens, refresh rotation and disconnect', async () => {
  const h = await setup();
  try {
    await h.service.call('connector.setPublicUrl', { url: `${PUBLIC}/mcp` });
    const unauth = await req(h.port, 'POST', '/mcp', { headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers['www-authenticate'], `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp", scope="studio"`);
    const prm = (await req(h.port, 'GET', '/.well-known/oauth-protected-resource/mcp')).json();
    assert.deepEqual([prm.resource, prm.authorization_servers], [`${PUBLIC}/mcp`, [PUBLIC]]);
    const asm = (await req(h.port, 'GET', '/.well-known/oauth-authorization-server')).json();
    assert.deepEqual([asm.issuer, asm.code_challenge_methods_supported, asm.registration_endpoint], [PUBLIC, ['S256'], `${PUBLIC}/register`]);
    assert.equal((await req(h.port, 'GET', '/.well-known/oauth-authorization-server', { host: `127.0.0.1:${h.port}` })).status, 404, 'no OAuth over plain local HTTP');
    assert.equal((await req(h.port, 'POST', '/register', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'X', redirect_uris: ['http://evil.example/cb'] }) })).json().error, 'invalid_redirect_uri');

    const t = await token(h);
    const mcp = (bearer: string, body: unknown, extra: Record<string, string> = {}, host?: string) => req(h.port, 'POST', '/mcp', { host, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}`, ...extra }, body: JSON.stringify(body) });
    const init = await mcp(t.access, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1' } } });
    assert.equal(init.json().result.serverInfo.name, 'multiverse-studio');
    const list = await mcp(t.access, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: modernMeta } }, H('tools/list'));
    const names = list.json().result.tools.map((x: { name: string }) => x.name);
    assert.deepEqual(names, ['studio_overview', 'create_project', 'open_project', 'get_studio_state', 'list_studio_commands', 'run_studio_command', 'read_file', 'list_files', 'look_at_page', 'undo_change']);
    assert.equal((await mcp(t.access, { jsonrpc: '2.0', id: 3, method: 'ping' }, {}, `127.0.0.1:${h.port}`)).status, 401, 'a remote token is not valid on the local address');
    assert.equal((await mcp(t.access, { jsonrpc: '2.0', id: 3, method: 'ping' }, { origin: 'https://evil.example' })).status, 403, 'foreign origins are refused');
    assert.equal((await mcp(t.access, { jsonrpc: '2.0', id: 3, method: 'ping' }, {}, 'evil.example')).status, 421, 'foreign host names are refused (DNS rebinding)');
    assert.equal((await req(h.port, 'GET', '/mcp', { headers: { authorization: `Bearer ${t.access}` } })).status, 405);

    // Refresh rotates: the old refresh token stops working.
    const r1 = await req(h.port, 'POST', '/token', t.form({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId, resource: `${PUBLIC}/mcp` }));
    assert.equal(r1.status, 200);
    assert.equal((await req(h.port, 'POST', '/token', t.form({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId }))).json().error, 'invalid_grant');
    assert.equal((await mcp(t.access, { jsonrpc: '2.0', id: 4, method: 'ping' })).status, 401, 'the previous access token is replaced');
    const fresh = r1.json().access_token as string;
    assert.equal((await mcp(fresh, { jsonrpc: '2.0', id: 5, method: 'ping' })).status, 200);

    const state = await h.service.call('connector.state', {});
    const app = state.apps.find((a) => a.name === 'ChatGPT')!;
    assert.deepEqual([app.kind, app.redirectHost], ['remote', 'chatgpt.com']);
    await h.service.call('connector.revoke', { appId: app.id });
    assert.equal((await mcp(fresh, { jsonrpc: '2.0', id: 6, method: 'ping' })).status, 401, 'disconnecting stops the app at once');
    // A declined connection redirects back with access_denied.
    const c = await connectRemote(h, 'Unknown app');
    const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_challenge: c.challenge, code_challenge_method: 'S256', state: 's2' });
    const wait = (await req(h.port, 'GET', `/authorize?${q}`)).headers.location!;
    const p = await waitFor(async () => (await h.service.call('connector.state', {})).pending.find((x) => x.kind === 'connect'));
    await h.service.call('connector.decide', { id: p.id, allow: false });
    const denied = await waitFor(async () => { const r = await req(h.port, 'GET', wait); return r.status === 302 ? r : null; });
    assert.equal(new URL(denied.headers.location!).searchParams.get('error'), 'access_denied');
  } finally {
    await h.cleanup();
  }
});

test('an app creates a project, changes it with undoable commands under its name, sees the page, and risky actions ask here', async () => {
  const h = await setup();
  try {
    await h.service.call('connector.setPublicUrl', { url: PUBLIC });
    const t = await token(h);
    let id = 10;
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await req(h.port, 'POST', '/mcp', { headers: { 'content-type': 'application/json', authorization: `Bearer ${t.access}`, ...H('tools/call', name) }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args, _meta: modernMeta } }) });
      assert.equal(r.status, 200, r.text);
      return r.json().result as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: Record<string, any>; isError: boolean };
    };
    const overview = await call('studio_overview', {});
    assert.match(overview.content[0]!.text!, /orbit: Orbit demo app/);
    const created = await call('create_project', { name: 'Example', template: 'orbit' });
    assert.equal(created.isError, false, created.content[0]!.text ?? "");
    const projectId = created.structuredContent!.projectId as string;
    assert.ok(h.events.some((e) => e.type === 'connector-show' && e.projectId === projectId && e.app === 'ChatGPT'), 'the studio window shows the project');
    const before = (await h.service.call('projects.open', { projectId })).checkpoints.length;
    const write = await call('run_studio_command', { project: 'Example', name: 'code.writeFile', args: { path: 'notes.md', text: '# Plan\n' } });
    assert.equal(write.isError, false, write.content[0]!.text ?? "");
    const edit = await call('run_studio_command', { project: projectId, name: 'code.editFile', args: { path: 'notes.md', edits: [{ find: '# Plan', replace: '# Launch plan' }] } });
    assert.equal(edit.isError, false, edit.content[0]!.text ?? "");
    assert.equal((await h.service.call('files.read', { projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID }, path: 'notes.md' })).text, '# Launch plan\n');
    const after = await h.service.call('projects.open', { projectId });
    assert.equal(after.checkpoints.length, before + 1, 'one checkpoint for the working session');
    assert.ok(after.checkpoints.some((c) => c.name === 'Before ChatGPT changes'));
    const log = await h.service.call('ops.activity', { projectId });
    const mine = log.filter((r) => r.actor === 'ai-app' && r.via === 'ChatGPT').map((r) => r.type);
    assert.deepEqual(mine.slice(0, 3).sort(), ['code.editFile', 'code.writeFile', 'project.createCheckpoint']);
    // Undo the edit by its activity id.
    const undo = await call('undo_change', { project: projectId, activity_id: edit.structuredContent!.activityId });
    assert.equal(undo.isError, false, undo.content[0]!.text ?? "");
    assert.equal((await h.service.call('files.read', { projectId, ref: { kind: 'line', lineId: SHARED_LINE_ID }, path: 'notes.md' })).text, '# Plan\n');
    // Reading and looking.
    const state = await call('get_studio_state', { project: projectId, include_assets: false });
    assert.match(state.content[0]!.text!, /"livingObjects"/);
    const file = await call('read_file', { project: projectId, path: 'app.html', start_line: 1, end_line: 3 });
    assert.match(file.content[0]!.text!, /^app\.html \(\d+ lines, hash [0-9a-f]+\)\n {4}1\| <!doctype html>/);
    const look = await call('look_at_page', { project: projectId, page: 'app.html', width: 800, height: 600 });
    assert.equal(look.content[0]!.type, 'image');
    assert.equal(look.content[0]!.mimeType, 'image/png');
    assert.ok(Buffer.from(look.content[0]!.data!, 'base64').subarray(1, 4).toString() === 'PNG');
    // Deleting a universe asks the person at the computer; declining leaves it in place.
    const uni = await call('run_studio_command', { project: projectId, name: 'project.createUniverse', args: { from: { kind: 'line', lineId: SHARED_LINE_ID }, name: 'Playful', color: 'rose', description: '', following: true } });
    assert.equal(uni.isError, false, uni.content[0]!.text ?? "");
    const lineId = (await h.service.call('projects.open', { projectId })).alternatives.find((a) => a.name === 'Playful')!.id;
    const pendingDelete = call('run_studio_command', { project: projectId, name: 'project.deleteUniverse', args: { lineId } });
    const ask = await waitFor(async () => (await h.service.call('connector.state', {})).pending.find((p) => p.kind === 'action'));
    assert.match(ask.title, /^ChatGPT: Delete a universe/);
    await h.service.call('connector.decide', { id: ask.id, allow: false });
    const declined = await pendingDelete;
    assert.equal(declined.isError, true);
    assert.match(declined.content[0]!.text!, /declined/);
    assert.ok((await h.service.call('projects.open', { projectId })).alternatives.some((a) => a.id === lineId));
    // Running the project's scripts executes code on this computer: an app asks every time.
    const pendingTests = call('run_studio_command', { project: projectId, name: 'code.runTests', args: { lineId: SHARED_LINE_ID } });
    const askTests = await waitFor(async () => (await h.service.call('connector.state', {})).pending.find((p) => p.kind === 'action'));
    assert.match(askTests.title, /^ChatGPT: Run the project’s tests/);
    await h.service.call('connector.decide', { id: askTests.id, allow: false });
    assert.match((await pendingTests).content[0]!.text!, /declined/);
    // Tool failures come back as results the model can read.
    const bad = await call('run_studio_command', { project: projectId, name: 'code.editFile', args: { path: 'missing.md', edits: [{ find: 'a', replace: 'b' }] } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text!, /does not exist/);
    const st = await h.service.call('connector.state', {});
    assert.ok(st.active.some((a) => a.appName === 'ChatGPT' && a.projectId === projectId));
    // Live activity: the app's work shows under its name, with real targets.
    const live = h.events.filter((e) => e.type === 'live').map((e) => (e as { event: import('../src/shared/live').LiveEvent }).event);
    const wrote = live.find((e) => e.operation === 'code.writeFile' && e.kind === 'operation.completed')!;
    assert.equal(wrote.taskId, 'app:ChatGPT');
    assert.equal(wrote.taskLabel, 'ChatGPT');
    assert.deepEqual(wrote.target, { kind: 'code', path: 'notes.md', ranges: [{ start: 1, end: 2 }], created: true });
    assert.ok(live.some((e) => e.taskId === 'app:ChatGPT' && e.phase === 'reading' && e.description === 'Reading app.html'));
    // Pause from the activity pill: changes are refused under the app's name, reads still work, resume allows them again.
    await h.service.call('connector.hold', { app: 'ChatGPT', held: true, projectId });
    const held = await call('run_studio_command', { project: projectId, name: 'code.writeFile', args: { path: 'held.md', text: 'x' } });
    assert.equal(held.isError, true);
    assert.match(held.content[0]!.text!, /paused changes from ChatGPT/);
    assert.equal((await call('read_file', { project: projectId, path: 'notes.md' })).isError, false);
    assert.ok(h.events.some((e) => e.type === 'live' && e.event.kind === 'task.paused' && e.event.taskId === 'app:ChatGPT'));
    assert.deepEqual((await h.service.call('connector.state', {})).held, ['ChatGPT']);
    await h.service.call('connector.hold', { app: 'ChatGPT', held: false, projectId });
    assert.equal((await call('run_studio_command', { project: projectId, name: 'code.writeFile', args: { path: 'held.md', text: 'x' } })).isError, false);
  } finally {
    await h.cleanup();
  }
});

test('local apps: the bridge relays stdio to the studio with the token from the user’s folder, after one approval by name', async () => {
  const h = await setup();
  const bridge = spawn(process.execPath, [path.join(ROOT, 'resources', 'connector', 'bridge.mjs')], { env: { ...process.env, MV_CONNECTOR_DIR: path.join(h.home, '.multiverse-studio') }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const discovery = JSON.parse(await fs.readFile(path.join(h.home, '.multiverse-studio', 'connector.json'), 'utf8'));
    assert.match(discovery.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal((await fs.stat(path.join(h.home, '.multiverse-studio', 'connector.json'))).mode & 0o077, 0, 'only this user can read the token');
    const lines = readline.createInterface({ input: bridge.stdout! });
    const replies = new Map<number, any>();
    lines.on('line', (l) => {
      const m = JSON.parse(l);
      replies.set(m.id, m);
    });
    const send = (m: unknown) => bridge.stdin!.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } });
    const ask = await waitFor(async () => (await h.service.call('connector.state', {})).pending.find((p) => p.kind === 'connect'));
    assert.equal(ask.appName, 'claude-ai');
    await h.service.call('connector.decide', { id: ask.id, allow: true });
    const init = await waitFor(() => replies.get(1));
    assert.equal(init.result.protocolVersion, '2025-06-18');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok((await waitFor(() => replies.get(2))).result.tools.some((t: { name: string }) => t.name === 'run_studio_command'));
    // A modern request: the bridge mirrors the body into the required headers.
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'studio_overview', arguments: {}, _meta: { ...modernMeta, 'io.modelcontextprotocol/clientInfo': { name: 'claude-ai', version: '1' } } } });
    const ov = await waitFor(() => replies.get(3));
    assert.equal(ov.result.resultType, 'complete');
    assert.match(ov.result.content[0].text, /Templates for create_project/);
    const st = await h.service.call('connector.state', {});
    assert.ok(st.apps.some((a) => a.kind === 'local' && a.name === 'claude-ai'));
    assert.equal(st.pending.length, 0, 'approved once, remembered');
    // Turned off: the bridge explains how to turn it on instead of hanging.
    await h.service.call('connector.setEnabled', { enabled: false });
    await assert.rejects(fs.access(path.join(h.home, '.multiverse-studio', 'connector.json')));
  } finally {
    bridge.kill();
    await h.cleanup();
  }
});

test('the Claude Desktop extension holds a valid manifest, the bridge and no secrets', async () => {
  const zip = await JSZip.loadAsync(await buildExtension(path.join(ROOT, 'resources'), '0.2.0'));
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  assert.equal(manifest.manifest_version, '0.3');
  assert.deepEqual(manifest.server, { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] } });
  assert.equal(manifest.tools.length, 10);
  assert.equal(await zip.file('server/index.js')!.async('string'), await fs.readFile(path.join(ROOT, 'resources', 'connector', 'bridge.mjs'), 'utf8'));
  assert.equal(JSON.parse(await zip.file('server/package.json')!.async('string')).type, 'module');
  assert.ok(zip.file('icon.png'));
  const all = (await Promise.all(Object.values(zip.files).map((f) => f.async('string')))).join('\n');
  assert.doesNotMatch(all, /token"\s*:\s*"[A-Za-z0-9_-]{20,}/);
});

test('a Cloudflare quick tunnel provides the public address; its process is stopped when turned off', async () => {
  const h = await setup();
  const bin = path.join(h.dir, 'bin');
  await fs.mkdir(bin);
  // A stand-in cloudflared: prints its address the way cloudflared does, then waits.
  await fs.writeFile(path.join(bin, 'cloudflared'), `#!${process.execPath}\nconsole.error('INF |  https://quiet-river-1234.trycloudflare.com  |');\nconsole.error(JSON.stringify(process.argv.slice(2)));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  try {
    const s = await h.service.call('connector.tunnel.start', {});
    assert.equal(s.tunnel.state, 'on');
    assert.equal(s.publicUrl, 'https://quiet-river-1234.trycloudflare.com/mcp');
    const meta = (await req(h.port, 'GET', '/.well-known/oauth-protected-resource', { host: 'quiet-river-1234.trycloudflare.com' })).json();
    assert.equal(meta.resource, 'https://quiet-river-1234.trycloudflare.com/mcp');
    const off = await h.service.call('connector.tunnel.stop', {});
    assert.deepEqual([off.tunnel.state, off.publicUrl], ['off', null]);
    await assert.rejects(h.service.call('connector.setPublicUrl', { url: 'http://insecure.example' }), /HTTPS/);
  } finally {
    process.env.PATH = PATH;
    await h.cleanup();
  }
});
