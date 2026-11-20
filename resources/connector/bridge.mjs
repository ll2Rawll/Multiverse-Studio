#!/usr/bin/env node
// Multiverse Studio bridge for local MCP clients (Claude Desktop extension, or any app that runs
// MCP servers as a command). It relays newline-delimited JSON-RPC between stdin/stdout and the
// studio's local endpoint, using the address and token in ~/.multiverse-studio/connector.json.
// If the studio is closed it starts it (from ~/.multiverse-studio/launch.json) and waits.
// No dependencies; Node 18 or later. Logs go to stderr only.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const DIR = process.env.MV_CONNECTOR_DIR || path.join(os.homedir(), '.multiverse-studio');
const META = 'io.modelcontextprotocol';
let clientName = 'Claude Desktop';
let legacyVersion = null;
let launched = false;

const log = (...a) => process.stderr.write(`[multiverse-studio] ${a.join(' ')}\n`);
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const errorFor = (id, message, code = -32000) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } });
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));
  } catch {
    return null;
  }
};

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    const d = readJson('connector.json');
    if (d && d.url && d.token) {
      try {
        await fetch(d.url.replace(/\/mcp$/, '/'), { signal: AbortSignal.timeout(1500) });
        return d;
      } catch {
        /* not up yet, or a stale file */
      }
    }
    if (!launched) {
      launched = true;
      const l = readJson('launch.json');
      if (l && typeof l.command === 'string') {
        log('Starting Multiverse Studio…');
        spawn(l.command, Array.isArray(l.args) ? l.args : [], { detached: true, stdio: 'ignore' }).unref();
      } else if (i === 0 && !d) return null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function forward(msg) {
  const id = msg && msg.id;
  const d = await endpoint();
  if (!d) {
    const e = errorFor(id, 'Multiverse Studio is not reachable. Open it and turn on Settings → AI apps → “Let AI apps use Multiverse Studio”.');
    if (e) write(e);
    return;
  }
  if (msg.method === 'initialize' && msg.params && msg.params.clientInfo && msg.params.clientInfo.name) clientName = String(msg.params.clientInfo.name);
  const meta = msg.params && msg.params._meta;
  if (meta && meta[`${META}/clientInfo`] && meta[`${META}/clientInfo`].name) clientName = String(meta[`${META}/clientInfo`].name);
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${d.token}`, 'x-mv-client': clientName.replace(/[^\w .()-]/g, '').slice(0, 60) };
  const modern = meta && meta[`${META}/protocolVersion`];
  if (modern) {
    // Mirror the body into the headers the HTTP binding requires.
    headers['mcp-protocol-version'] = String(modern);
    headers['mcp-method'] = String(msg.method);
    if (msg.method === 'tools/call' && msg.params && typeof msg.params.name === 'string') {
      const n = msg.params.name;
      headers['mcp-name'] = /^[\x21-\x7e]+$/.test(n) && !/^=\?base64\?.*\?=$/.test(n) ? n : `=?base64?${Buffer.from(n, 'utf8').toString('base64')}?=`;
    }
  } else if (legacyVersion) headers['mcp-protocol-version'] = legacyVersion;
  let res;
  try {
    res = await fetch(d.url, { method: 'POST', headers, body: JSON.stringify(msg) });
  } catch (e) {
    const err = errorFor(id, `Multiverse Studio did not answer: ${e.message}`);
    if (err) write(err);
    return;
  }
  if (res.status === 202 || id === undefined) return;
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    if (msg.method === 'initialize' && body.result && body.result.protocolVersion) legacyVersion = body.result.protocolVersion;
    write(body);
  } catch {
    write(errorFor(id, res.status === 403 ? 'Declined in Multiverse Studio.' : `Multiverse Studio answered ${res.status}.`));
  }
}

const rl = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  // Requests run concurrently (a long tool call must not block a ping); initialize goes first.
  if (msg.method === 'initialize') queue = queue.then(() => forward(msg));
  else void queue.then(() => forward(msg)).catch((e) => log(e.message));
});
rl.on('close', () => setTimeout(() => process.exit(0), 200));
