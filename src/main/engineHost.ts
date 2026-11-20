import { Worker } from 'node:worker_threads';
import type { IpcResult } from '../shared/ipc';
import type { StudioEvent } from '../shared/types';
import { answerVaultRequest, type VaultRequest } from '../ai/remoteVault';
import type { SecretVault } from '../ai/vault';
import type { BrowserProbe, BrowserProbeRequest, RecordRequest, StoryProbeRequest } from '../agent/browser';

interface PreviewReply {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

type Pending = { kind: 'call'; resolve: (r: IpcResult<unknown>) => void } | { kind: 'preview'; resolve: (r: PreviewReply) => void } | { kind: 'media-file'; resolve: (r: { path: string; mime: string } | null) => void };

/** Runs the engine in a worker thread and restarts it if it ever crashes. */
export class EngineHost {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private restarts = 0;

  constructor(
    private readonly script: string,
    private readonly config: { workspaceRoot: string; sampleRoot: string; templateRoot: string; resourcesRoot: string; aiSettingsFile: string; publishSettingsFile: string; cacheRoot: string; connectorRoot: string; launch: { command: string; args: string[] } | null },
    private readonly onEvent: (event: StudioEvent) => void,
    private readonly vault: SecretVault,
    private readonly probe: BrowserProbe,
  ) {
    this.start();
  }

  private start(): void {
    const worker = new Worker(this.script, { workerData: this.config });
    worker.on('message', (message: { type: string; id?: number; result?: IpcResult<unknown>; event?: StudioEvent } & Partial<PreviewReply>) => {
      if (message.type === 'event' && message.event) {
        this.onEvent(message.event);
        return;
      }
      if (message.type === 'vault') {
        void answerVaultRequest(this.vault, message as unknown as VaultRequest).then((reply) => worker.postMessage(reply));
        return;
      }
      if (message.type === 'probe') {
        const m = message as unknown as { id: number; request: BrowserProbeRequest };
        void this.probe.check(m.request).then(
          (value) => worker.postMessage({ type: 'probe-result', id: m.id, ok: true, value }),
          (error: Error) => worker.postMessage({ type: 'probe-result', id: m.id, ok: false, error: error.message }),
        );
        return;
      }
      if (message.type === 'record') {
        const m = message as unknown as { id: number; request: RecordRequest };
        const record = this.probe.record?.bind(this.probe);
        if (!record) {
          worker.postMessage({ type: 'record-result', id: m.id, ok: false, error: 'Recording is not available.' });
          return;
        }
        void record(m.request).then(
          (value) => worker.postMessage({ type: 'record-result', id: m.id, ok: true, value }),
          (error: Error) => worker.postMessage({ type: 'record-result', id: m.id, ok: false, error: error.message }),
        );
        return;
      }
      if (message.type === 'story') {
        const m = message as unknown as { id: number; request: StoryProbeRequest };
        const story = this.probe.story?.bind(this.probe);
        if (!story) {
          worker.postMessage({ type: 'story-result', id: m.id, ok: false, error: 'Stories need the desktop app’s browser.' });
          return;
        }
        void story(m.request, (index, result) => worker.postMessage({ type: 'story-step', id: m.id, index, result })).then(
          (value) => worker.postMessage({ type: 'story-result', id: m.id, ok: true, value }),
          (error: Error) => worker.postMessage({ type: 'story-result', id: m.id, ok: false, error: error.message }),
        );
        return;
      }
      if (message.type === 'shutdown-done') {
        this.shutdownDone?.();
        return;
      }
      const entry = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (!entry) return;
      this.pending.delete(message.id!);
      if (entry.kind === 'call' && message.type === 'result' && message.result) entry.resolve(message.result);
      else if (entry.kind === 'preview' && message.type === 'preview') {
        entry.resolve({ status: message.status ?? 500, headers: message.headers ?? {}, body: message.body ?? new Uint8Array() });
      } else if (entry.kind === 'media-file' && message.type === 'media-file') {
        entry.resolve((message as unknown as { file: { path: string; mime: string } | null }).file);
      }
    });
    const fail = (reason: string): void => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const [id, entry] of this.pending) {
        this.pending.delete(id);
        if (entry.kind === 'call') entry.resolve({ ok: false, error: { code: 'engine-restarted', message: `The project engine stopped (${reason}). It has been restarted; please try again.` } });
        else if (entry.kind === 'media-file') entry.resolve(null);
        else entry.resolve({ status: 503, headers: { 'Content-Type': 'text/plain' }, body: new TextEncoder().encode('Preview temporarily unavailable') });
      }
      if (this.restarts++ < 5) {
        this.onEvent({ type: 'notice', level: 'error', message: 'The project engine stopped unexpectedly and was restarted. Your saved work is safe.' });
        setTimeout(() => this.start(), 250);
      }
    };
    worker.on('error', (error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    worker.on('exit', (code) => fail(`exit code ${code}`));
    this.worker = worker;
  }

  call(channel: string, input: unknown): Promise<IpcResult<unknown>> {
    const worker = this.worker;
    if (!worker) return Promise.resolve({ ok: false, error: { code: 'engine-starting', message: 'The project engine is restarting. Try again in a moment.' } });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { kind: 'call', resolve });
      worker.postMessage({ type: 'call', id, channel, input });
    });
  }

  preview(token: string, pathname: string, origin: string): Promise<PreviewReply> {
    const worker = this.worker;
    if (!worker) return Promise.resolve({ status: 503, headers: {}, body: new Uint8Array() });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { kind: 'preview', resolve });
      worker.postMessage({ type: 'preview', id, token, pathname, origin });
    });
  }

  /** Where a project's media file is on disk (asked by the mvmedia: protocol). */
  mediaFile(projectId: string, assetId: string, variant: string): Promise<{ path: string; mime: string } | null> {
    const worker = this.worker;
    if (!worker) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { kind: 'media-file', resolve });
      worker.postMessage({ type: 'media-file', id, projectId, assetId, variant });
    });
  }

  private shutdownDone: (() => void) | null = null;

  /** Ask the worker to stop tasks and child processes, then terminate it. */
  async dispose(): Promise<void> {
    const worker = this.worker;
    this.restarts = Number.POSITIVE_INFINITY;
    if (worker) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => {
          this.shutdownDone = resolve;
          worker.postMessage({ type: 'shutdown' });
        }),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 4000); }),
      ]);
      clearTimeout(timer);
      this.worker = null;
      await worker.terminate();
    }
  }
}
