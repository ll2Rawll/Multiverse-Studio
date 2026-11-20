/**
 * API key storage. Keys never leave the privileged side: the renderer can only ask whether a key
 * is present and how it is stored.
 *
 * - `EncryptedFileVault` persists keys encrypted by an OS-backed cipher (Electron `safeStorage`:
 *   DPAPI on Windows, Keychain on macOS, the Secret Service/kwallet on Linux). Ciphertext is stored
 *   in `credentials.json`; plaintext is never written.
 * - When OS encryption is unavailable, or the user chooses it, keys are kept for this session only.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KeyStorage, VaultStatus } from '../shared/ai';
import { writeFileAtomic } from '../engine/store/atomic';

export type KeyPersistence = 'persistent' | 'session';

export interface SecretVault {
  status(): Promise<VaultStatus>;
  get(id: string): Promise<string | null>;
  describe(id: string): Promise<{ present: boolean; storage: KeyStorage }>;
  set(id: string, key: string, persistence: KeyPersistence): Promise<KeyStorage>;
  delete(id: string): Promise<void>;
  /** Every stored key, so the redactor can remove them from text. */
  values(): Promise<string[]>;
}

export class VaultError extends Error {
  readonly code = 'vault';
}

export class MemoryVault implements SecretVault {
  private readonly keys = new Map<string, string>();
  constructor(private readonly reason = 'This environment has no OS-backed key storage, so keys are kept for this session only.') {}
  async status(): Promise<VaultStatus> {
    return { persistent: false, backend: 'session memory', detail: this.reason };
  }
  async get(id: string): Promise<string | null> {
    return this.keys.get(id) ?? null;
  }
  async describe(id: string): Promise<{ present: boolean; storage: KeyStorage }> {
    return this.keys.has(id) ? { present: true, storage: 'session' } : { present: false, storage: 'none' };
  }
  async set(id: string, key: string, persistence: KeyPersistence): Promise<KeyStorage> {
    if (persistence === 'persistent') throw new VaultError(`${this.reason} Choose “This session only” to continue.`);
    this.keys.set(id, key);
    return 'session';
  }
  async delete(id: string): Promise<void> {
    this.keys.delete(id);
  }
  async values(): Promise<string[]> {
    return [...this.keys.values()];
  }
}

export interface Cipher {
  available(): boolean;
  backend(): string;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, string>;
}

export class EncryptedFileVault implements SecretVault {
  private readonly session = new MemoryVault();
  private cache: VaultFile | null = null;

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  async status(): Promise<VaultStatus> {
    if (this.cipher.available()) return { persistent: true, backend: this.cipher.backend(), detail: `Keys are encrypted with ${this.cipher.backend()} and saved on this computer.` };
    return { persistent: false, backend: this.cipher.backend(), detail: `Secure storage is not available (${this.cipher.backend()}). Keys can be used for this session only and are not saved.` };
  }

  private async read(): Promise<VaultFile> {
    if (this.cache) return this.cache;
    try {
      const json = JSON.parse(await fs.readFile(this.file, 'utf8')) as VaultFile;
      this.cache = json && json.version === 1 && typeof json.entries === 'object' ? json : { version: 1, entries: {} };
    } catch {
      this.cache = { version: 1, entries: {} };
    }
    return this.cache;
  }

  private async write(data: VaultFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(data), { mode: 0o600 });
    await fs.chmod(this.file, 0o600).catch(() => undefined);
    this.cache = data;
  }

  private queue: Promise<unknown> = Promise.resolve();
  /** Changes run one at a time, so two keys saved together can't overwrite each other. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async get(id: string): Promise<string | null> {
    const fromSession = await this.session.get(id);
    if (fromSession) return fromSession;
    const data = await this.read();
    const entry = data.entries[id];
    if (!entry || !this.cipher.available()) return null;
    try {
      return this.cipher.decrypt(Buffer.from(entry, 'base64'));
    } catch {
      return null; // encrypted for another OS account or a reset key store
    }
  }

  async describe(id: string): Promise<{ present: boolean; storage: KeyStorage }> {
    if ((await this.session.describe(id)).present) return { present: true, storage: 'session' };
    const data = await this.read();
    return data.entries[id] && this.cipher.available() ? { present: true, storage: 'os-encrypted' } : { present: false, storage: 'none' };
  }

  set(id: string, key: string, persistence: KeyPersistence): Promise<KeyStorage> {
    return this.serial(() => this.setNow(id, key, persistence));
  }

  private async setNow(id: string, key: string, persistence: KeyPersistence): Promise<KeyStorage> {
    if (persistence === 'session') {
      await this.deletePersistent(id);
      return this.session.set(id, key, 'session');
    }
    if (!this.cipher.available()) throw new VaultError('Secure storage is not available on this computer, so the key cannot be saved. Choose “This session only”.');
    const data = await this.read();
    await this.write({ version: 1, entries: { ...data.entries, [id]: this.cipher.encrypt(key).toString('base64') } });
    await this.session.delete(id);
    return 'os-encrypted';
  }

  private async deletePersistent(id: string): Promise<void> {
    const data = await this.read();
    if (!(id in data.entries)) return;
    const entries = { ...data.entries };
    delete entries[id];
    await this.write({ version: 1, entries });
  }

  delete(id: string): Promise<void> {
    return this.serial(async () => {
      await this.session.delete(id);
      await this.deletePersistent(id);
    });
  }

  async values(): Promise<string[]> {
    const out = await this.session.values();
    const data = await this.read();
    if (this.cipher.available()) {
      for (const entry of Object.values(data.entries)) {
        try {
          out.push(this.cipher.decrypt(Buffer.from(entry, 'base64')));
        } catch {
          // ignore undecryptable entries
        }
      }
    }
    return out;
  }
}
