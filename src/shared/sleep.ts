/**
 * Waits `ms`, or rejects with `onAbort()` as soon as the signal aborts (also when it already has).
 * Leaves no listener on the signal, so long polling loops don't pile up abort listeners.
 */
export function abortableSleep(ms: number, signal: AbortSignal | undefined, onAbort: () => Error): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(onAbort());
    const abort = (): void => {
      clearTimeout(timer);
      reject(onAbort());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
