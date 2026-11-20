// Browser-harness stand-in for the Electron preload bridge: same shape, HTTP transport.
const listeners = new Set<(e: unknown) => void>();
const source = new EventSource('/api/events');
source.onmessage = (message) => {
  const event = JSON.parse(message.data) as unknown;
  for (const l of listeners) l(event);
};

(window as unknown as { multiverse: unknown }).multiverse = {
  host: 'browser-harness',
  async invoke(channel: string, input: unknown): Promise<unknown> {
    const res = await fetch('/api/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, input }) });
    return res.json();
  },
  onEvent(callback: (event: unknown) => void): () => void {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
