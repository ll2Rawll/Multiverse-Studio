/**
 * Engine worker thread. All project storage, merging, diffing and parsing runs here,
 * off both the UI thread and Electron's main thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { StudioService } from '../services/studio';
import { toIpcError } from '../services/errors';
import { isChannelName, parseChannelInput } from '../shared/ipc';
import { AiService } from '../ai/service';
import { RemoteVault } from '../ai/remoteVault';
import { RemoteBrowserProbe } from '../agent/remoteProbe';
import { redactor } from '../ai/redact';

interface WorkerConfig {
  workspaceRoot: string;
  sampleRoot: string;
  templateRoot: string;
  resourcesRoot: string;
  aiSettingsFile: string;
  connectorRoot: string;
  launch: { command: string; args: string[] } | null;
  publishSettingsFile: string;
  cacheRoot: string;
}

type Incoming =
  | { type: 'call'; id: number; channel: string; input: unknown }
  | { type: 'media-file'; id: number; projectId: string; assetId: string; variant: string }
  | { type: 'preview'; id: number; token: string; pathname: string; origin: string };

const port = parentPort;
if (!port) throw new Error('engineWorker must run as a worker thread');
const config = workerData as WorkerConfig;

// Keys stay in the main process; the worker asks for one per request.
const vault = new RemoteVault(port);
const probe = new RemoteBrowserProbe(port);
const service = new StudioService({
  workspaceRoot: config.workspaceRoot,
  sampleRoot: config.sampleRoot,
  templateRoot: config.templateRoot,
  resourcesRoot: config.resourcesRoot,
  cacheRoot: config.cacheRoot,
  previewUrl: (token) => `mvpreview://${token}/`,
  emit: (event) => port.postMessage({ type: 'event', event }),
  ai: new AiService(config.aiSettingsFile, vault),
  agent: { cacheRoot: config.cacheRoot, probe },
  // Publishing tokens use the same main-process vault under their own ids (publish:<target>).
  publish: { vault, settingsFile: config.publishSettingsFile },
  // Connect AI apps (off until the user turns it on in Settings → AI apps).
  connector: { root: config.connectorRoot, launch: config.launch },
});

// Node ends a worker on an unhandled rejection. A failed background step (a job update on a full
// disk, say) must not take every open project down with it: report it and keep serving.
process.on('unhandledRejection', (reason) => {
  const detail = redactor.redact(reason instanceof Error ? reason.message : String(reason)).slice(0, 300);
  port.postMessage({ type: 'event', event: { type: 'notice', level: 'error', message: `A background step failed: ${detail}` } });
});

port.on('message', (message: Incoming) => {
  if (vault.handle(message) || probe.handle(message)) return;
  if ((message as { type?: string }).type === 'shutdown') {
    // Stop tasks and their child processes (dev servers, tests) before the app exits.
    void service.shutdown().finally(() => port.postMessage({ type: 'shutdown-done' }));
    return;
  }
  void (async () => {
    if (message.type === 'call') {
      try {
        if (!isChannelName(message.channel)) throw new Error('Unknown channel');
        // Input was validated in the main process too; validating again keeps the worker self-contained.
        const input = parseChannelInput(message.channel, message.input);
        const value = await service.call(message.channel, input);
        port.postMessage({ type: 'result', id: message.id, result: { ok: true, value } });
      } catch (error) {
        port.postMessage({ type: 'result', id: message.id, result: { ok: false, error: toIpcError(error) } });
      }
      return;
    }
    if (message.type === 'media-file') {
      const ok = /^[A-Za-z0-9._-]{1,128}$/.test(message.projectId) && /^[a-z0-9-]{1,64}$/.test(message.assetId) && ['original', 'play', 'thumb', 'strip'].includes(message.variant);
      const file = ok ? await service.video.mediaFile(message.projectId, message.assetId, message.variant as 'play').catch(() => null) : null;
      port.postMessage({ type: 'media-file', id: message.id, file });
      return;
    }
    if (message.type === 'preview') {
      try {
        const response = await service.servePreview(message.token, message.pathname, message.origin);
        // Copy so transferring never detaches buffers held by the content cache.
        const body = new Uint8Array(response.body);
        port.postMessage({ type: 'preview', id: message.id, status: response.status, headers: response.headers, body }, [body.buffer]);
      } catch (error) {
        const body = new TextEncoder().encode(`Preview error: ${toIpcError(error).message}`);
        port.postMessage({ type: 'preview', id: message.id, status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body }, [body.buffer]);
      }
    }
  })();
});
