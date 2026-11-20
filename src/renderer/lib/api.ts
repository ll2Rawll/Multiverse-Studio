/** Typed client for the IPC bridge exposed by the preload script (or the test harness). */
import type { ChannelInput, ChannelName, ChannelOutput, IpcError, IpcResult } from '../../shared/ipc';
import type { StudioEvent } from '../../shared/types';

interface Bridge {
  host: string;
  invoke(channel: string, input: unknown): Promise<unknown>;
  onEvent(callback: (event: unknown) => void): () => void;
  pathsForFiles?(files: File[]): string[];
}

declare global {
  interface Window {
    multiverse?: Bridge;
  }
}

export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(error: IpcError) {
    super(error.message);
    this.code = error.code;
    this.details = error.details;
  }
}

function bridge(): Bridge {
  const b = window.multiverse;
  if (!b) throw new ApiError({ code: 'no-bridge', message: 'Multiverse Studio must run inside its desktop app.' });
  return b;
}

/** Observers of outgoing calls (live activity uses them to notice the person's own edits). */
export const callHooks: ((channel: string, input: unknown) => void)[] = [];

export async function call<C extends ChannelName>(channel: C, input: ChannelInput<C>): Promise<ChannelOutput<C>> {
  for (const hook of callHooks) {
    try {
      hook(channel, input);
    } catch {
      // observers never block a call
    }
  }
  const result = (await bridge().invoke(channel, input)) as IpcResult<ChannelOutput<C>>;
  if (!result || typeof result !== 'object' || !('ok' in result)) throw new ApiError({ code: 'bad-response', message: 'Unexpected response from the app.' });
  if (!result.ok) throw new ApiError(result.error);
  return result.value;
}

export function onStudioEvent(callback: (event: StudioEvent) => void): () => void {
  return bridge().onEvent((event) => callback(event as StudioEvent));
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function hasBridge(): boolean {
  return Boolean(window.multiverse);
}

/** Paths of dropped files, where the host can provide them (the desktop app). */
export function droppedPaths(files: FileList | File[]): string[] {
  return window.multiverse?.pathsForFiles?.(Array.from(files)) ?? [];
}
