/**
 * The application's credential vault, backed by Electron safeStorage (DPAPI on Windows, Keychain on
 * macOS, Secret Service/kwallet on Linux). On Linux, the `basic_text` backend uses a hard-coded
 * password, so it is treated as unavailable and keys are offered for the session only.
 */
import { safeStorage } from 'electron';
import path from 'node:path';
import { EncryptedFileVault, type Cipher } from '../ai/vault';

export function createKeyVault(userData: string): EncryptedFileVault {
  const backend = (): string => {
    if (process.platform === 'win32') return 'Windows data protection (DPAPI)';
    if (process.platform === 'darwin') return 'the macOS Keychain';
    try {
      return `Linux ${safeStorage.getSelectedStorageBackend()}`;
    } catch {
      return 'Linux secret storage';
    }
  };
  const cipher: Cipher = {
    available: () => {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === 'linux') {
        try {
          const b = safeStorage.getSelectedStorageBackend();
          return b !== 'basic_text' && b !== 'unknown';
        } catch {
          return false;
        }
      }
      return true;
    },
    backend,
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  };
  return new EncryptedFileVault(path.join(userData, 'ai', 'credentials.json'), cipher);
}
