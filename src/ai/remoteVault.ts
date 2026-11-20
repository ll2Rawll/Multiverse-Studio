/**
 * Vault proxy used inside the engine worker. The real vault (with Electron's safeStorage) lives in
 * the main process; the worker asks for a key only when it is about to make a request.
 */
import type { KeyStorage, VaultStatus } from '../shared/ai';
import type { KeyPersistence, SecretVault } from './vault';
import { VaultError } from './vault';

export type VaultOp = 'status' | 'get' | 'describe' | 'set' | 'delete' | 'values';
export interface VaultRequest {
  type: 'vault';
  id: number;
  op: VaultOp;
  args: unknown[];
}
export interface VaultReply {
  type: 'vault-result';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface PortLike {
  postMessage(message: unknown): void;
}

export class RemoteVault implements SecretVault {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly port: PortLike) {}

  /** Feed replies from the port here. Returns true when the message was a vault reply. */
  handle(message: unknown): boolean {
    const m = message as VaultReply;
    if (!m || m.type !== 'vault-result') return false;
    const entry = this.pending.get(m.id);
    if (!entry) return true;
    this.pending.delete(m.id);
    if (m.ok) entry.resolve(m.value);
    else entry.reject(new VaultError(m.error ?? 'The key store is unavailable.'));
    return true;
  }

  private call<T>(op: VaultOp, ...args: unknown[]): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ type: 'vault', id, op, args } satisfies VaultRequest);
    });
  }

  status(): Promise<VaultStatus> {
    return this.call('status');
  }
  get(id: string): Promise<string | null> {
    return this.call('get', id);
  }
  describe(id: string): Promise<{ present: boolean; storage: KeyStorage }> {
    return this.call('describe', id);
  }
  set(id: string, key: string, persistence: KeyPersistence): Promise<KeyStorage> {
    return this.call('set', id, key, persistence);
  }
  delete(id: string): Promise<void> {
    return this.call('delete', id);
  }
  values(): Promise<string[]> {
    return this.call('values');
  }
}

/** Main-process side: answer a vault request from the worker. */
export async function answerVaultRequest(vault: SecretVault, request: VaultRequest): Promise<VaultReply> {
  try {
    const [a, b, c] = request.args as [string, string, KeyPersistence];
    let value: unknown;
    switch (request.op) {
      case 'status':
        value = await vault.status();
        break;
      case 'get':
        value = await vault.get(a);
        break;
      case 'describe':
        value = await vault.describe(a);
        break;
      case 'set':
        value = await vault.set(a, b, c);
        break;
      case 'delete':
        value = await vault.delete(a);
        break;
      case 'values':
        value = await vault.values();
        break;
      default:
        throw new Error('Unknown vault operation');
    }
    return { type: 'vault-result', id: request.id, ok: true, value };
  } catch (error) {
    return { type: 'vault-result', id: request.id, ok: false, error: (error as Error).message };
  }
}
