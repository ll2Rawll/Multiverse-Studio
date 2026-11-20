import { CommandError } from '../commands/commands';
import { UnsupportedProjectVersionError } from '../engine/store/migrations';
import { StudioError } from '../engine/errors';
import { UnsafePathError } from '../shared/paths';
import { ProjectDamagedError } from '../engine/store/manifestFile';
import type { IpcError } from '../shared/ipc';

/** Convert any thrown value into a structured, user-readable IPC error. */
export function toIpcError(error: unknown): IpcError {
  if (error instanceof StudioError) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof ProjectDamagedError) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof CommandError) return { code: error.code, message: error.message };
  if (error instanceof UnsupportedProjectVersionError) return { code: error.code, message: error.message };
  if (error instanceof UnsafePathError) return { code: error.code, message: `${error.message}: ${error.input}` };
  const issues = (error as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (Array.isArray(issues)) {
    return { code: 'invalid-input', message: 'The request was not valid.', details: issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC') return { code: 'disk-full', message: 'There is not enough disk space to save. Free some space and try again — nothing was lost.' };
  if (code === 'EACCES' || code === 'EPERM') return { code: 'no-permission', message: 'Multiverse Studio does not have permission to write there.' };
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) };
}
