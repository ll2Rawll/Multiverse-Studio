import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rename with retries. On Windows, antivirus scanners and indexers briefly hold
 * handles on new files, which makes rename fail with EPERM/EBUSY.
 */
export async function renameWithRetry(from: string, to: string, attempts = 12): Promise<void> {
  let delay = 15;
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || attempt >= attempts) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 400);
    }
  }
}

/**
 * Crash-safe write: write a temporary file in the same directory, flush it to disk,
 * then atomically replace the destination.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  // Created with its final mode, so a private file is never readable by others, even briefly.
  const handle = await fs.open(tmp, 'w', options.mode ?? 0o666);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined); // e.g. disk full: leave no partial temp file
    throw error;
  }
  await handle.close();
  try {
    await renameWithRetry(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Write only if the destination does not exist yet (content-addressed objects). */
export async function writeFileOnce(file: string, data: string | Uint8Array): Promise<boolean> {
  try {
    await fs.access(file);
    return false;
  } catch {
    // continue
  }
  await writeFileAtomic(file, data);
  return true;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(file: string): Promise<unknown> {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text) as unknown;
}
