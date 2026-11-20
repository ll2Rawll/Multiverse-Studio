/**
 * Sandboxed preload. Exposes three capabilities to the UI: invoking an allow-listed IPC channel
 * (validated again in the main process), listening for studio events, and reading the paths of
 * files the user dropped onto the window.
 * Project previews run in sandboxed subframes and never receive this bridge.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

const INVOKE = 'mv:invoke';
const EVENT = 'mv:event';

contextBridge.exposeInMainWorld('multiverse', {
  host: 'electron',
  invoke(channel: string, input: unknown): Promise<unknown> {
    if (typeof channel !== 'string') return Promise.reject(new Error('Invalid channel'));
    return ipcRenderer.invoke(INVOKE, channel, input);
  },
  /** Paths of files dropped onto the window (the main process still asks before importing them). */
  pathsForFiles(files: File[]): string[] {
    return Array.from(files)
      .map((f) => {
        try {
          return webUtils.getPathForFile(f);
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  },
  onEvent(callback: (event: unknown) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on(EVENT, listener);
    return () => {
      ipcRenderer.removeListener(EVENT, listener);
    };
  },
});
